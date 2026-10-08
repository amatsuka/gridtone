// Критерий этапа 4а: воркер считает полные `Features` по окну сетки после правок; вкладка «Анализ» показывает
// карту яркости 3 × N, разброс L, контраст соседей, распознанный ритм с силой и палитру сетки; всё
// пересчитывается после правки и перестановки. Значения панели сверяются с core по тем же прокси 512.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { deltaE2000, srgbToCielab } from '../../src/core/color/deltaE';
import { oklabToLinearSrgb } from '../../src/core/color/oklab';
import { encodeSrgbClamped } from '../../src/core/color/transfer';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Adjust, Project, Vec3 } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, press, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e4a-'));
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
/** Допуск L между воркером (декодер Chromium) и core (sharp) по тому же прокси. */
const L_TOLERANCE = 0.005;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

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

/** Анализ сетки core по проекту из main и признакам по ассетам. */
function coreAnalysis(project: Project, byAsset: ReadonlyMap<string, TileMetrics>): GridAnalysis {
  const bySlot = Object.fromEntries(project.slots.map((slot) => [slot.id, byAsset.get(slot.assetId ?? '')]));
  return analyzeGrid(project, bySlot);
}

const num = async (locator: Locator, attribute: string) => Number(await locator.getAttribute(attribute));

/** L клеток карты по порядку; null — признаков ещё нет. */
async function mapL(page: Page): Promise<(number | null)[]> {
  return page
    .getByTestId('luma-cell')
    .evaluateAll((cells) => cells.map((cell) => (cell.hasAttribute('data-l') ? Number(cell.getAttribute('data-l')) : null)));
}

/** Ждёт, пока все плитки посчитаны: в карте у каждой клетки есть L, хода «посчитано N из M» нет. */
async function expectMeasured(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', String(count));
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
}

/** Панель против core: L каждой клетки, ритм, разброс и контраст соседей. */
async function expectPanelMatchesCore(page: Page, expected: GridAnalysis): Promise<void> {
  const L = await mapL(page);
  expected.cells.forEach((cell, i) => {
    expect(Math.abs((L[i] ?? NaN) - (cell.L ?? NaN)), `клетка ${i + 1}: ${L[i]}, core ${cell.L}`).toBeLessThan(L_TOLERANCE);
  });
  const metrics = expected.metrics;
  if (!metrics || metrics.rhythm.kind === 'flat') throw new Error('core: ожидался анализ сетки с ритмом');
  const rhythm = page.getByTestId('rhythm');
  await expect(rhythm).toHaveAttribute('data-kind', metrics.rhythm.kind);
  await expect(rhythm).toHaveAttribute('data-template', metrics.rhythm.best.template);
  expect(Math.abs((await num(rhythm, 'data-strength')) - metrics.rhythm.best.strength)).toBeLessThan(0.02);
  expect(Math.abs((await num(page.getByTestId('luma-spread'), 'data-value')) - metrics.spread)).toBeLessThan(0.003);
  const contrast = page.getByTestId('neighbor-contrast');
  expect(Math.abs((await num(contrast, 'data-horizontal')) - (metrics.contrast.horizontal ?? NaN))).toBeLessThan(0.003);
  expect(Math.abs((await num(contrast, 'data-vertical')) - (metrics.contrast.vertical ?? NaN))).toBeLessThan(0.003);
}

test('шахматка: карта, ритм, разброс и контраст как в core; пересчёт после правки, отмены и перестановки', async () => {
  // Светлые на чётных позициях, тёмные на нечётных; у каждой плитки свой серый, чтобы сверять клетки по отдельности.
  const light = [200, 206, 194, 210, 198];
  const dark = [70, 62, 76, 66];
  const colors = Array.from({ length: 9 }, (_, i) => gray(i % 2 === 0 ? (light[i / 2] as number) : (dark[(i - 1) / 2] as number)));
  const projectDir = join(root, 'Шахматка');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'checker'), colors));
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) byAsset.set(id, await coreMetrics(projectDir, id));

  // 1. Вкладка «Анализ»: 9 клеток, ритм «Шахматка» с силой > 0.9, числа — как в core.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expect(page.getByTestId('luma-cell')).toHaveCount(9);
  await expectMeasured(page, 9);
  await expect(page.getByTestId('rhythm')).toContainText('Шахматка');
  expect(await num(page.getByTestId('rhythm'), 'data-strength')).toBeGreaterThan(0.9);
  await expectPanelMatchesCore(page, coreAnalysis((await mainProject(page))!, byAsset));
  const strength = await num(page.getByTestId('rhythm'), 'data-strength');
  const lightL = (await mapL(page))[2] as number;
  await expect(page.getByTestId('grid-palette-entry').first()).toBeVisible();

  // Клик по клетке выделяет плитку.
  await page.getByTestId('luma-cell').nth(5).click();
  await expect(page.getByTestId('tile').nth(5)).toHaveAttribute('aria-selected', 'true');

  // 2. Экспозиция −2 на светлой плитке 3: клетка темнеет меньше чем за 2 с после возврата на «Анализ».
  await page.getByTestId('tile').nth(2).click();
  await page.getByRole('tab', { name: 'Фото' }).click();
  await press(page, 'Экспозиция', 'ArrowLeft', 40);
  await expect(page.getByTestId('value-exposure')).toHaveText('−2.00');
  await page.getByRole('tab', { name: 'Анализ' }).click();
  const started = Date.now();
  await expect.poll(async () => (await mapL(page))[2] ?? 1, { timeout: 2000 }).toBeLessThan(lightL - 0.1);
  expect(Date.now() - started).toBeLessThan(2000);
  await expectMeasured(page, 9);
  const darkened = new Map(byAsset).set(ids[2]!, await coreMetrics(projectDir, ids[2]!, { exposure: -2 }));
  await expectPanelMatchesCore(page, coreAnalysis((await mainProject(page))!, darkened));
  expect(await num(page.getByTestId('rhythm'), 'data-strength')).toBeLessThan(strength - 0.1);

  // 3. ⌘Z возвращает шахматку; Shift+→ ставит светлую плитку 3 на место тёмной 4 и ломает шахматку.
  for (let i = 0; i < 40; i++) await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[2]?.adjust.exposure).toBe(0);
  await expect.poll(async () => Math.abs(((await mapL(page))[2] ?? 0) - lightL)).toBeLessThan(1e-9);
  await expectPanelMatchesCore(page, coreAnalysis((await mainProject(page))!, byAsset));

  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await mainProject(page))?.slots[3]?.assetId).toBe(ids[2]);
  // Карта следует новому порядку: клетка — слот на этой позиции.
  const order = (await mainProject(page))!.slots.map((slot) => slot.id);
  await expect
    .poll(() => page.getByTestId('luma-cell').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-slot-id'))))
    .toEqual(order);
  const reordered = coreAnalysis((await mainProject(page))!, byAsset);
  await expectPanelMatchesCore(page, reordered);
  expect(reordered.metrics?.rhythm.kind).toBe('none');
  await expect(page.getByTestId('rhythm')).toHaveAttribute('data-kind', 'none');
  await expect(page.getByTestId('rhythm')).toContainText('Не распознан');
});

/** OKLab → sRGB 0..1 со срезом в охват, для ΔE2000. */
const rgb01 = (lab: Vec3) => encodeSrgbClamped(oklabToLinearSrgb(lab));
const deltaE = (a: Vec3, b: Vec3) => deltaE2000(srgbToCielab(rgb01(a)), srgbToCielab(rgb01(b)));

test('полосы по строкам: светлые тёплые и тёмные холодные; палитра сетки — оба цвета, как в core', async () => {
  // Ряды 1 и 3 — светлые тёплые, ряд 2 — тёмный холодный. Цвета различаются на 1–2 из 255: одинаковые файлы
  // импорт пропустил бы, а соседние значения JPEG q95 часто кодирует одними байтами. Эти дают разные файлы,
  // и в каждой группе цвета ближе 0.005 в OKLab — палитра сетки сливает их в один цвет с запасом.
  const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });
  const warm = [rgb(225, 195, 150), rgb(225, 195, 151), rgb(225, 196, 151), rgb(225, 195, 152), rgb(225, 196, 150), rgb(227, 195, 150)];
  const cold = [rgb(50, 70, 110), rgb(50, 70, 111), rgb(52, 70, 110)];
  const colors = [...warm.slice(0, 3), ...cold, ...warm.slice(3)];
  const projectDir = join(root, 'Полосы');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'rows'), colors));
  const byAsset = new Map<string, TileMetrics>();
  for (const id of ids) byAsset.set(id, await coreMetrics(projectDir, id));
  const expected = coreAnalysis((await mainProject(page))!, byAsset);

  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  await expect(page.getByTestId('rhythm')).toHaveAttribute('data-template', 'rows');
  await expect(page.getByTestId('rhythm')).toContainText('Полосы по строкам');
  await expectPanelMatchesCore(page, expected);

  // Палитра сетки: столько же цветов, что у core, каждый ближе ΔE2000 2; среди них — тёплый и холодный.
  const entries = await page.getByTestId('grid-palette-entry').evaluateAll((els) =>
    els.map((el) => ({ lab: (el.getAttribute('data-lab') ?? '').split(' ').map(Number), share: Number(el.getAttribute('data-share')) })),
  );
  const palette = expected.metrics!.palette;
  expect(entries).toHaveLength(palette.length);
  entries.forEach((entry, i) => {
    const d = deltaE(entry.lab as Vec3, palette[i]!.lab);
    expect(d, `цвет ${i + 1}: ΔE2000 ${d.toFixed(2)}`).toBeLessThan(2);
    expect(Math.abs(entry.share - palette[i]!.share)).toBeLessThan(0.02);
  });
  for (const i of [0, 4]) {
    const color = byAsset.get(ids[i]!)!.dominant;
    expect(Math.min(...palette.map((e) => deltaE(e.lab, color))), `цвет плитки ${i + 1} в палитре`).toBeLessThan(2);
  }
});

test('три фото: «Нужно хотя бы 6 плиток с фото», признаки плиток при этом посчитаны', async () => {
  const projectDir = join(root, 'Мало');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'few'), [gray(60), gray(140), gray(220)]));
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 3);
  await expect(page.getByTestId('analysis-too-few')).toContainText('Нужно хотя бы 6 плиток с фото');
  await expect(page.getByTestId('rhythm')).toHaveCount(0);
  await expect(page.getByTestId('grid-palette')).toHaveCount(0);
  const L = await mapL(page);
  for (const [i, id] of ids.entries()) {
    expect(Math.abs((L[i] ?? NaN) - (await coreMetrics(projectDir, id)).meanL)).toBeLessThan(L_TOLERANCE);
  }
});
