// Критерий этапа 4б: тип гармонии сетки (шаблон Мацуды или «нейтральная») и оценка — средний выход тонов
// за сектора; колесо тонов с точками плиток и наложенным шаблоном, совпадающим с core; пересчёт после правки.
// Значения панели сверяются с core по тем же прокси 512.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { hueDistance } from '../../src/core/color/math';
import { lchToSrgb } from '../../src/core/color/swatches';
import type { HarmonyTemplateId } from '../../src/core/harmony/templates';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Adjust, Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, press, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e4b-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const W = 900;
const H = 1200;
/** Допуски между воркером (декодер Chromium) и core (sharp) по тому же прокси. */
const HUE_TOLERANCE = 1;
const CHROMA_TOLERANCE = 0.003;
const SCORE_TOLERANCE = 0.3;

/** Цвет OKLCH → sRGB 0..255 для однотонного фото. */
const lch = (hue: number, chroma: number, L = 0.72): Rgb => {
  const [r, g, b] = lchToSrgb(L, chroma, hue);
  return { r: r * 255, g: g * 255, b: b * 255 };
};

/** Новый проект в папке dir с фото по порядку. Возвращает id ассетов в порядке сетки. */
async function createProject(dir: string, photos: string[]): Promise<{ page: Page; ids: string[] }> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: dir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${photos.length}`);
  return { page, ids: await expectTilesRendered(page, photos.length) };
}

/** Однотонные фото по порядку: имя начинается с номера, импорт ставит их по алфавиту путей. */
async function solidPhotos(dir: string, colors: readonly Rgb[]): Promise<string[]> {
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(dir, `${i + 1}`, W, H, () => color));
  return files;
}

/** Признаки по прокси ассета, как их считает core: окно по умолчанию, поправка фото. */
async function coreMetrics(projectDir: string, assetId: string, adjust: Partial<Adjust> = {}): Promise<TileMetrics> {
  return tileMetrics(await readProxyImage(projectDir, assetId), createCrop(), '3:4', { photo: { ...createAdjust(), ...adjust } });
}

async function coreAnalysis(page: Page, byAsset: ReadonlyMap<string, TileMetrics>): Promise<GridAnalysis> {
  const project = (await mainProject(page)) as Project;
  const bySlot = Object.fromEntries(project.slots.map((slot) => [slot.id, byAsset.get(slot.assetId ?? '')]));
  return analyzeGrid(project, bySlot);
}

/** Ждёт, пока все плитки посчитаны: хода «посчитано N из M» нет. */
async function expectMeasured(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', String(count));
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
}

interface PanelPoint {
  slotId: string;
  hue: number;
  chroma: number;
  outside: boolean;
}

async function panelPoints(page: Page): Promise<PanelPoint[]> {
  return page.getByTestId('harmony-point').evaluateAll((els) =>
    els.map((el) => ({
      slotId: el.getAttribute('data-slot-id') ?? '',
      hue: Number(el.getAttribute('data-hue')),
      chroma: Number(el.getAttribute('data-chroma')),
      outside: el.getAttribute('data-outside') === 'true',
    })),
  );
}

/** Разность углов шаблона с учётом периода: у I и X угол определён с точностью до 180°. */
function angleError(template: HarmonyTemplateId, a: number, b: number): number {
  const period = template === 'I' || template === 'X' ? 180 : 360;
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

/** Колесо и гармония панели против core: точки, их положение относительно секторов, тип, угол, оценка, сектора. */
async function expectHarmonyMatchesCore(page: Page, expected: GridAnalysis): Promise<void> {
  const metrics = expected.metrics;
  if (!metrics) throw new Error('core: ожидался анализ сетки');
  const { harmony, wheel } = metrics;
  const panel = page.getByTestId('harmony');
  await expect(panel).toHaveAttribute('data-kind', harmony.kind);

  const points = await panelPoints(page);
  expect(points.map((p) => p.slotId)).toEqual(wheel.map((p) => p.slotId));
  wheel.forEach((point, i) => {
    const shown = points[i] as PanelPoint;
    expect(Math.abs(shown.chroma - point.chroma), `хрома точки ${i + 1}`).toBeLessThan(CHROMA_TOLERANCE);
    // У почти серой точки тон — шум.
    if (point.chroma > 0.02) expect(hueDistance(shown.hue, point.hue), `тон точки ${i + 1}`).toBeLessThan(HUE_TOLERANCE);
    expect(shown.outside, `точка ${i + 1} вне шаблона`).toBe(harmony.kind === 'template' && harmony.tiles[i]!.outside);
  });

  const sectors = page.getByTestId('harmony-sector');
  if (harmony.kind === 'neutral') {
    await expect(sectors).toHaveCount(0);
    return;
  }
  const { best } = harmony;
  await expect(panel).toHaveAttribute('data-template', best.template);
  const angle = Number(await panel.getAttribute('data-angle'));
  expect(angleError(best.template, angle, best.angle), `угол ${angle}, core ${best.angle}`).toBeLessThan(HUE_TOLERANCE);
  const score = Number(await panel.getAttribute('data-score'));
  expect(Math.abs(score - best.score), `оценка ${score}, core ${best.score}`).toBeLessThan(SCORE_TOLERANCE);
  // Наложенный шаблон — сектора core.
  const shownSectors = await sectors.evaluateAll((els) =>
    els.map((el) => ({ center: Number(el.getAttribute('data-center')), width: Number(el.getAttribute('data-width')) })),
  );
  expect(shownSectors.map((s) => s.width)).toEqual(best.sectors.map((s) => s.width));
  shownSectors.forEach((sector, i) => expect(hueDistance(sector.center, best.sectors[i]!.center)).toBeLessThan(HUE_TOLERANCE));
}

test('аналоговые тона 40–90°: шаблон V, все точки внутри, тип, угол и оценка как в core', async () => {
  const hues = [40, 50, 60, 70, 80, 90];
  const projectDir = join(root, 'Аналоговая');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'analog'), hues.map((h) => lch(h, 0.11))));
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) byAsset.set(id, await coreMetrics(projectDir, id));
  const expected = await coreAnalysis(page, byAsset);
  const harmony = expected.metrics?.harmony;
  if (harmony?.kind !== 'template') throw new Error('core: ожидался шаблон');
  expect(harmony.best.template).toBe('V');
  expect(harmony.tiles.every((tile) => tile.distance === 0)).toBe(true);

  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 6);
  await expect(page.getByTestId('harmony-wheel')).toBeVisible();
  await expect(page.getByTestId('harmony')).toContainText('V — аналоговая');
  await expect(page.getByTestId('harmony-score')).toContainText('все тона в секторах');
  await expect(page.getByTestId('harmony-outside')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('harmony-point')).toHaveCount(6);
  await expect(page.getByTestId('harmony-sector')).toHaveCount(1);
  await expectHarmonyMatchesCore(page, expected);

  // Клик по точке выделяет плитку.
  await page.getByTestId('harmony-point').nth(3).click();
  await expect(page.getByTestId('tile').nth(3)).toHaveAttribute('aria-selected', 'true');
});

test('оранжевые, голубые и одна зелёная: шаблон I, зелёная вне шаблона; насыщенность −100 уводит её к центру', async () => {
  // Оранжевые и голубые — на противоположных тонах, зелёная — между ними, у всех одна хрома.
  const orange = [lch(55, 0.11), lch(60, 0.11), lch(65, 0.11)];
  const blue = [lch(235, 0.11), lch(240, 0.11)];
  const green = lch(145, 0.11);
  const colors = [orange[0]!, blue[0]!, orange[1]!, blue[1]!, orange[2]!, green];
  const projectDir = join(root, 'Противоположные');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'opposite'), colors));
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) byAsset.set(id, await coreMetrics(projectDir, id));
  const expected = await coreAnalysis(page, byAsset);
  const harmony = expected.metrics?.harmony;
  if (harmony?.kind !== 'template') throw new Error('core: ожидался шаблон');
  expect(harmony.best.template).toBe('I');
  expect(harmony.tiles.map((tile) => tile.outside)).toEqual([false, false, false, false, false, true]);

  // 1. Шаблон I, зелёная точка помечена «вне шаблона», панель совпадает с core.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 6);
  await expect(page.getByTestId('harmony')).toHaveAttribute('data-template', 'I');
  await expect(page.getByTestId('harmony-outside')).toHaveAttribute('data-count', '1');
  await expectHarmonyMatchesCore(page, expected);
  const greenPoint = page.locator(`[data-testid="harmony-point"][data-slot-id="${expected.cells[5]!.slotId}"]`);
  await expect(greenPoint).toHaveAttribute('data-outside', 'true');
  await expect(greenPoint).toHaveAttribute('title', /вне шаблона/);
  const score = Number(await page.getByTestId('harmony').getAttribute('data-score'));
  expect(score).toBeGreaterThan(5);

  // 2. Насыщенность −100 на зелёной: точка уходит к центру, остаток почти ноль.
  await greenPoint.click();
  await expect(page.getByTestId('tile').nth(5)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Фото' }).click();
  await press(page, 'Насыщенность', 'Home', 1);
  await expect(page.getByTestId('value-saturation')).toHaveText('−100');
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expect.poll(async () => Number(await greenPoint.getAttribute('data-chroma')), { timeout: 2000 }).toBeLessThan(0.01);
  await expectMeasured(page, 6);
  await expect(greenPoint).toHaveAttribute('data-outside', 'false');
  expect(Number(await page.getByTestId('harmony').getAttribute('data-score'))).toBeLessThan(0.5);
  await expect(page.getByTestId('harmony-outside')).toHaveAttribute('data-count', '0');
  const faded = new Map(byAsset).set(ids[5]!, await coreMetrics(projectDir, ids[5]!, { saturation: -100 }));
  const fadedExpected = await coreAnalysis(page, faded);
  expect(fadedExpected.metrics?.harmony.kind === 'template' && fadedExpected.metrics.harmony.best.template).toBe('I');
  await expectHarmonyMatchesCore(page, fadedExpected);
});

test('серые с лёгким оттенком: «Нейтральная сетка», без шаблона и отметок', async () => {
  // Хрома 0.006 — оттенок виден рядом с чистым серым, но тон таких плиток не оценивается.
  const colors = [0.45, 0.52, 0.6, 0.66, 0.74, 0.8].map((L, i) => lch(i * 60 + 20, 0.006, L));
  const projectDir = join(root, 'Нейтральная');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'neutral'), colors));
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) byAsset.set(id, await coreMetrics(projectDir, id));
  const expected = await coreAnalysis(page, byAsset);
  expect(expected.metrics?.harmony.kind).toBe('neutral');

  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 6);
  await expect(page.getByTestId('harmony')).toContainText('Нейтральная сетка');
  await expect(page.getByTestId('harmony-score')).toHaveCount(0);
  await expect(page.getByTestId('harmony-point')).toHaveCount(6);
  await expectHarmonyMatchesCore(page, expected);
});
