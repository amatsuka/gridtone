// Критерий этапа 4в: плитки, которые по L, температуре или хроме отклоняются от цели или соседей больше
// допуска либо лежат вне секторов шаблона, перечислены во вкладке «Анализ» с причиной и величиной; режим 7
// без `slot.target` показывает отклонение от ожидания сетки; опубликованные плитки — контекст.
// Значения панели и режима 7 сверяются с core по тем же прокси 512.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { hueDistance } from '../../src/core/color/math';
import { lchToSrgb } from '../../src/core/color/swatches';
import { median, type TileExpectation } from '../../src/core/harmony/outliers';
import type { DeviationReason } from '../../src/core/metrics/deviation';
import { meanChroma, meanHue, TEMPERATURE_AXIS } from '../../src/core/metrics/features';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Project, SlotTarget } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e4c-'));
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
const VALUE_TOLERANCE: Record<DeviationReason, number> = { L: 0.005, temperature: 0.002, chroma: 0.002, hue: 1 };
/** Отклонение в долях допуска: шум декодера, делённый на допуск. */
const RATIO_TOLERANCE = 0.15;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/** Цвет OKLCH → sRGB 0..255 для однотонного фото. */
const lch = (L: number, chroma: number, hue: number): Rgb => {
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

async function openProject(dir: string, count: number): Promise<Page> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [dir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, count);
  return page;
}

/** Однотонные фото по порядку: имя начинается с номера, импорт ставит их по алфавиту путей. */
async function solidPhotos(dir: string, colors: readonly Rgb[]): Promise<string[]> {
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(dir, `${i + 1}`, W, H, () => color));
  return files;
}

/** Признаки по прокси ассета, как их считает core: окно по умолчанию, без правок. */
async function coreMetrics(projectDir: string, ids: readonly string[]): Promise<Map<string, TileMetrics>> {
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) {
    byAsset.set(id, tileMetrics(await readProxyImage(projectDir, id), createCrop(), '3:4', { photo: createAdjust() }));
  }
  return byAsset;
}

/** Анализ core по проекту из main (с его целями и статусами) и признакам по ассетам. */
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

interface PanelReason {
  reason: DeviationReason;
  value: number;
  expected: number;
  ratio: number;
}

interface PanelOutlier {
  slotId: string;
  index: number;
  deviation: number;
  source: string;
  published: boolean;
  text: string;
  reasons: PanelReason[];
}

async function panelOutliers(page: Page): Promise<PanelOutlier[]> {
  return page.getByTestId('outlier').evaluateAll((els) =>
    els.map((el) => ({
      slotId: el.getAttribute('data-slot-id') ?? '',
      index: Number(el.getAttribute('data-index')),
      deviation: Number(el.getAttribute('data-deviation')),
      source: el.getAttribute('data-source') ?? '',
      published: el.getAttribute('data-published') === 'true',
      text: el.textContent ?? '',
      reasons: [...el.querySelectorAll('[data-testid="outlier-reason"]')].map((r) => ({
        reason: r.getAttribute('data-reason') as DeviationReason,
        value: Number(r.getAttribute('data-value')),
        expected: Number(r.getAttribute('data-expected')),
        ratio: Number(r.getAttribute('data-ratio')),
      })),
    })),
  );
}

function expectClose(reason: DeviationReason, shown: number, core: number, what: string): void {
  const error = reason === 'hue' ? hueDistance(shown, core) : Math.abs(shown - core);
  expect(error, `${what}: ${shown}, core ${core}`).toBeLessThan(VALUE_TOLERANCE[reason]);
}

/** Список выбросов панели против core: те же плитки в том же порядке, те же причины, значения и ожидания. */
async function expectOutliersMatchCore(page: Page, expected: GridAnalysis): Promise<PanelOutlier[]> {
  const shown = await panelOutliers(page);
  expect(shown.map((o) => o.slotId)).toEqual(expected.outliers.map((o) => o.slotId));
  expected.outliers.forEach((core, i) => {
    const row = shown[i] as PanelOutlier;
    const name = `выброс ${core.index + 1}`;
    expect(row.index).toBe(core.index);
    expect(row.source).toBe(core.source);
    expect(row.published).toBe(core.published);
    expect(Math.abs(row.deviation - core.deviation), `${name}: отклонение ${row.deviation}, core ${core.deviation}`).toBeLessThan(RATIO_TOLERANCE);
    expect(row.reasons.map((r) => r.reason), name).toEqual(core.reasons.map((r) => r.reason));
    core.reasons.forEach((part, j) => {
      const r = row.reasons[j] as PanelReason;
      expectClose(part.reason, r.value, part.value, `${name}, ${part.reason}`);
      expectClose(part.reason, r.expected, part.expected, `${name}, ожидание ${part.reason}`);
      expect(Math.abs(r.ratio - part.ratio), `${name}, ${part.reason} в долях допуска`).toBeLessThan(RATIO_TOLERANCE);
    });
  });
  // По величине отклонения.
  for (let i = 1; i < shown.length; i++) expect(shown[i - 1]!.deviation).toBeGreaterThanOrEqual(shown[i]!.deviation);
  return shown;
}

/** Режим 7: у каждой плитки — отклонение core, выбросы > 1, остальные < 1. */
async function expectDeviationMatchesCore(page: Page, expected: GridAnalysis): Promise<void> {
  const tiles = page.getByTestId('tile');
  for (const e of expected.expectations) {
    const fill = tiles.nth(e.index).getByTestId('tile-fill');
    await expect(fill).toHaveAttribute('data-kind', 'deviation');
    await expect(fill).toHaveAttribute('data-source', e.source);
    const value = Number(await fill.getAttribute('data-value'));
    expect(Math.abs(value - e.deviation), `плитка ${e.index + 1}: ${value}, core ${e.deviation}`).toBeLessThan(RATIO_TOLERANCE);
    if (e.reasons.length > 0) expect(value, `плитка ${e.index + 1} — выброс`).toBeGreaterThan(1);
    else expect(value, `плитка ${e.index + 1} в допуске`).toBeLessThan(1);
  }
}

const expectationOf = (analysis: GridAnalysis, index: number): TileExpectation => {
  const e = analysis.expectations.find((x) => x.index === index);
  if (!e) throw new Error(`core: у плитки ${index + 1} нет ожидания`);
  return e;
};

test('шахматка серых: плитка 5 темнее — «яркость», ожидание — медиана остальных светлых; цель и опубликованная', async () => {
  // Светлые места — 1, 3, 5, 7, 9; плитка 5 темнее остальных светлых. Тёмные — 2, 4, 6, 8.
  const levels = [200, 70, 205, 66, 150, 74, 190, 62, 210];
  const projectDir = join(root, 'Шахматка');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'checker'), levels.map(gray)));
  const byAsset = await coreMetrics(projectDir, ids);
  const expected = await coreAnalysis(page, byAsset);
  const rhythm = expected.metrics?.rhythm;
  expect(rhythm?.kind === 'pattern' && rhythm.best.template).toBe('checker');
  expect(expected.outliers.map((o) => o.index)).toEqual([4]);
  const otherLight = [0, 2, 6, 8].map((i) => byAsset.get(ids[i]!)!.meanL);

  // 1. Один выброс — плитка 5, причина «яркость», ожидание — медиана остальных светлых.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  await expect(page.getByTestId('outliers-count')).toHaveAttribute('data-count', '1');
  const [dark] = await expectOutliersMatchCore(page, expected);
  expect(dark!.index).toBe(4);
  expect(dark!.reasons.map((r) => r.reason)).toEqual(['L']);
  expect(Math.abs(dark!.reasons[0]!.expected - median(otherLight))).toBeLessThan(VALUE_TOLERANCE.L);
  await expect(page.getByTestId('outlier')).toContainText(/^5яркость 0\.\d\d → 0\.\d\d$/);

  // Клик по строке выделяет плитку.
  await page.getByTestId('outlier').click();
  await expect(page.getByTestId('tile').nth(4)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('outlier')).toHaveAttribute('aria-pressed', 'true');

  // 2. Плитка 5 опубликована, у плитки 1 — цель L 0.6: её ожидание — цель, а не соседи.
  await app!.close();
  app = undefined;
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  const target: SlotTarget = { L: 0.6, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true };
  project.slots[0]!.target = target;
  project.slots[4]!.state = 'published';
  await writeFile(file, JSON.stringify(project, null, 2));

  const reopened = await openProject(projectDir, 9);
  const withTarget = await coreAnalysis(reopened, byAsset);
  expect(withTarget.outliers.map((o) => [o.index, o.source, o.published])).toEqual([
    [0, 'target', false],
    [4, 'grid', true],
  ]);
  await reopened.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(reopened, 9);
  const [targeted, published] = await expectOutliersMatchCore(reopened, withTarget);
  expect(targeted!.reasons[0]!.expected).toBe(target.L);
  expect(targeted!.text).toContain('по цели');
  expect(published!.text).toContain('опубликован');

  // Опубликованная плитка — в медиане класса: без неё у светлой плитки 3 было бы другое ожидание.
  const third = expectationOf(withTarget, 2);
  const withoutPublished = median([0, 6, 8].map((i) => byAsset.get(ids[i]!)!.meanL));
  const L3 = byAsset.get(ids[2]!)!.meanL;
  expect(third.parts.find((p) => p.reason === 'L')!.expected).toBeCloseTo(median([0, 4, 6, 8].map((i) => byAsset.get(ids[i]!)!.meanL)), 12);
  expect(Math.abs(third.deviation - Math.abs(L3 - withoutPublished) / 0.06)).toBeGreaterThan(RATIO_TOLERANCE);

  // Режим 7: у плитки с целью — отклонение от цели, у остальных — от сетки; значения как у core.
  await reopened.keyboard.press('Digit7');
  await expectDeviationMatchesCore(reopened, withTarget);
  await expect(reopened.getByTestId('tile').nth(0).getByTestId('tile-fill')).toHaveAttribute('title', /^Ожидание — цель позиции\nяркость/);
});

test('холодная сетка: тёплая — «температура», блёклая — «насыщенность», вне сектора — «тон»; режим 7', async () => {
  // Девять плиток одного холодного тона (205°, хрома 0.05) шахматкой по светлоте. Плитка 3 сдвинута по оси
  // температуры, у плитки 6 хрома вдвое меньше, плитка 7 отведена по тону за край сектора с почти прежними
  // температурой и хромой (тон и хрома подобраны так, чтобы их сдвиг был в допуске). Светлота одинаковых
  // плиток чуть разная: одинаковые файлы импорт считает одним фото.
  const HUE = 205;
  const CHROMA = 0.05;
  const LEVELS = [0.8, 0.55, 0.8, 0.562, 0.812, 0.55, 0.8, 0.538, 0.788];
  const a0 = CHROMA * Math.cos((HUE * Math.PI) / 180);
  const b0 = CHROMA * Math.sin((HUE * Math.PI) / 180);
  const warmShift = 0.014;
  const [ua, ub] = TEMPERATURE_AXIS;
  const warm = { a: a0 + ua * warmShift, b: b0 + ub * warmShift };
  const colors = LEVELS.map((L) => lch(L, CHROMA, HUE));
  colors[2] = lch(LEVELS[2]!, meanChroma(warm.a, warm.b), meanHue(warm.a, warm.b));
  colors[5] = lch(LEVELS[5]!, CHROMA / 2, HUE);
  colors[6] = lch(LEVELS[6]!, CHROMA * 0.92, HUE + 27);

  const projectDir = join(root, 'Холодная');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'cold'), colors));
  const expected = await coreAnalysis(page, await coreMetrics(projectDir, ids));
  const harmony = expected.metrics?.harmony;
  if (harmony?.kind !== 'template') throw new Error('core: ожидался шаблон');
  expect(harmony.best.template).toBe('i');
  const reasons = Object.fromEntries(expected.outliers.map((o) => [o.index, o.reasons.map((r) => r.reason)]));
  expect(reasons[2]).toEqual(['temperature']);
  expect(reasons[5]?.[0]).toBe('chroma');
  expect(reasons[6]).toEqual(['hue']);
  expect(Object.keys(reasons).map(Number).sort()).toEqual([2, 5, 6]);
  // «25° за краем»: по расстоянию core, сектор прижат к выбросу краем.
  expect(harmony.tiles[6]!.distance).toBeGreaterThan(20);
  expect(harmony.tiles[6]!.distance).toBeLessThan(30);

  // Список: три плитки по величине, с причинами и «было → ожидается», как у core.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  await expect(page.getByTestId('outliers-count')).toHaveAttribute('data-count', '3');
  const shown = await expectOutliersMatchCore(page, expected);
  const row = (index: number) => page.locator(`[data-testid="outlier"][data-index="${index}"]`);
  await expect(row(2)).toContainText(/температура −0\.\d{3} → −0\.\d{3}/);
  await expect(row(5)).toContainText(/насыщенность 0\.\d{3} → 0\.\d{3}/);
  await expect(row(6)).toContainText(/тон \d+° → \d+°/);
  // Вне сектора на колесе — та же плитка.
  await expect(page.locator(`[data-testid="harmony-point"][data-slot-id="${shown.find((o) => o.index === 6)!.slotId}"]`)).toHaveAttribute(
    'data-outside',
    'true',
  );

  // Клик по строке выделяет плитку.
  await row(5).click();
  await expect(page.getByTestId('tile').nth(5)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tile').nth(2)).toHaveAttribute('aria-selected', 'false');

  // 3. Режим 7 без целей — отклонение от ожидания сетки: у выбросов > 1, у остальных < 1, как у core.
  await page.keyboard.press('Digit7');
  await expectDeviationMatchesCore(page, expected);
  await expect(page.getByTestId('tile').nth(6).getByTestId('tile-fill')).toHaveAttribute('title', /^Ожидание — по сетке\n.*\nтон \d+° → \d+°/s);
});
