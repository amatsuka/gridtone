// Критерий этапа 4г: у выброса — конкретная поправка (экспозиция, температура, насыщенность или тон HSL);
// «Применить» пишет её в поправку фото одной записью истории, и плитка попадает в допуск; цель за лимитом —
// «заменить», без кнопки. Поправки панели сверяются с поиском core по тем же прокси 512.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { lchToSrgb } from '../../src/core/color/swatches';
import { findFix, searchWindow, type FixSlider, type TileFix } from '../../src/core/harmony/fixes';
import type { RgbaImage } from '../../src/core/image/sample';
import { meanChroma, meanHue, TEMPERATURE_AXIS, TINT_AXIS } from '../../src/core/metrics/features';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, windowRgb } from '../../src/core/metrics/tile';
import type { Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e4d-'));
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
/** Значение ползунка панели против поиска core по тому же прокси: экспозиция ±0.02 EV, остальные ±1 деление. */
const VALUE_TOLERANCE: Record<FixSlider, number> = { exposure: 0.02 + 1e-9, temp: 1, saturation: 1, hslHue: 1 };
/** Светлота шахматки холодной сетки (4в); одинаковые файлы импорт считает одним фото — чуть разные. */
const LEVELS = [0.8, 0.55, 0.8, 0.562, 0.812, 0.55, 0.8, 0.538, 0.788];

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/** Цвет OKLCH → sRGB 0..255 для однотонного фото. */
const lch = (L: number, chroma: number, hue: number): Rgb => {
  const [r, g, b] = lchToSrgb(L, chroma, hue);
  return { r: r * 255, g: g * 255, b: b * 255 };
};

async function createProject(dir: string, photos: string[]): Promise<Page> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: dir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${photos.length}`);
  await expectTilesRendered(page, photos.length);
  return page;
}

async function openProject(dir: string, count: number): Promise<Page> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [dir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, count);
  return page;
}

/** Выход без ожидания автосохранения. */
async function quit(): Promise<void> {
  await app!.close();
  app = undefined;
}

/** Правит project.json закрытого проекта. */
async function editProjectFile(dir: string, change: (project: Project) => void): Promise<void> {
  const file = join(dir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  change(project);
  await writeFile(file, JSON.stringify(project, null, 2));
}

/** Однотонные фото по порядку: имя начинается с номера, импорт ставит их по алфавиту путей. */
async function solidPhotos(dir: string, colors: readonly Rgb[]): Promise<string[]> {
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(dir, `${i + 1}`, W, H, () => color));
  return files;
}

interface CoreState {
  project: Project;
  analysis: GridAnalysis;
  /** Прокси по ассету — для поиска поправки. */
  images: Map<string, RgbaImage>;
}

/** Анализ core по проекту из main с его правками: признаки по тем же прокси, окно и поправка фото слота. */
async function coreState(page: Page, projectDir: string): Promise<CoreState> {
  const project = (await mainProject(page)) as Project;
  const images = new Map<string, RgbaImage>();
  const bySlot: Record<string, ReturnType<typeof tileMetrics>> = {};
  for (const slot of project.slots) {
    const assetId = slot.assetId as string;
    if (!images.has(assetId)) images.set(assetId, await readProxyImage(projectDir, assetId));
    bySlot[slot.id] = tileMetrics(images.get(assetId)!, slot.crop, project.grid.ratio, { photo: slot.adjust });
  }
  return { project, analysis: analyzeGrid(project, bySlot), images };
}

/** Поиск core для выброса в позиции index — как в воркере, по худшей причине. */
function coreFix({ project, analysis, images }: CoreState, index: number): TileFix {
  const outlier = analysis.outliers.find((o) => o.index === index);
  if (!outlier) throw new Error(`core: плитка ${index + 1} не выброс`);
  const slot = project.slots[index]!;
  const { reason, value, expected, tolerance } = outlier.reasons[0]!;
  const window = searchWindow(windowRgb(images.get(slot.assetId!)!, slot.crop, project.grid.ratio), project.grid.ratio);
  return findFix(window, { photo: slot.adjust }, { reason, value, expected, tolerance, source: outlier.source });
}

const reasonsByIndex = (analysis: GridAnalysis) => analysis.outliers.map((o) => [o.index, o.reasons.map((r) => r.reason)]);

/** Ждёт, пока все плитки посчитаны: хода «посчитано N из M» нет. */
async function expectMeasured(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', String(count));
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
}

/** Строка поправки под выбросом в позиции index. */
function fixLine(page: Page, index: number): Locator {
  return page
    .locator('li.outlier-row', { has: page.locator(`[data-testid="outlier"][data-index="${index}"]`) })
    .getByTestId('outlier-fix');
}

/** Позиции выбросов в списке, по возрастанию. */
async function outlierIndices(page: Page): Promise<number[]> {
  const indices = await page.getByTestId('outlier').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-index'))));
  return indices.sort((a, b) => a - b);
}

interface ShownFix {
  state: string;
  slider: string;
  from: number;
  value: number;
  reached: number;
  bands: string;
  text: string;
}

async function shownFix(line: Locator): Promise<ShownFix> {
  return line.evaluate((el) => ({
    state: el.getAttribute('data-state') ?? '',
    slider: el.getAttribute('data-slider') ?? '',
    from: Number(el.getAttribute('data-from')),
    value: Number(el.getAttribute('data-value')),
    reached: Number(el.getAttribute('data-reached')),
    bands: el.getAttribute('data-bands') ?? '',
    text: el.textContent ?? '',
  }));
}

/** Поправка панели совпадает с поиском core: ползунок, значение, «заменить», диапазоны тона. */
async function expectFixMatchesCore(page: Page, index: number, core: TileFix): Promise<ShownFix> {
  const line = fixLine(page, index);
  await expect(line).toHaveAttribute('data-state', core.replace ? 'replace' : 'fix');
  const shown = await shownFix(line);
  const name = `плитка ${index + 1}`;
  expect(shown.slider, name).toBe(core.slider);
  expect(shown.from, name).toBe(core.from);
  expect(Math.abs(shown.value - core.value), `${name}: ${shown.value}, core ${core.value}`).toBeLessThanOrEqual(VALUE_TOLERANCE[core.slider]);
  expect(shown.bands, name).toBe(core.bands?.join(' ') ?? '');
  await expect(line.getByTestId('apply-fix')).toHaveCount(core.replace ? 0 : 1);
  return shown;
}

async function deviationOf(page: Page, index: number): Promise<number> {
  const fill = page.getByTestId('tile').nth(index).getByTestId('tile-fill');
  await expect(fill).toHaveAttribute('data-kind', 'deviation');
  return Number(await fill.getAttribute('data-value'));
}

test('шахматка: «Экспозиция +N EV» как у core, «Применить» одной записью, перезапуск; за 1 EV — «заменить»', async () => {
  // Плитка 5 на светлом месте темнее остальных светлых: ей нужно около +0.7 EV.
  const levels = [200, 70, 205, 66, 165, 74, 190, 62, 210];
  const projectDir = join(root, 'Шахматка');
  const page = await createProject(projectDir, await solidPhotos(join(root, 'checker'), levels.map(gray)));
  const before = await coreState(page, projectDir);
  expect(reasonsByIndex(before.analysis)).toEqual([[4, ['L']]]);
  const core = coreFix(before, 4);
  expect(core.slider).toBe('exposure');
  expect(core.exact).toBe(true);
  expect(core.value).toBeGreaterThan(0.3);
  expect(core.value).toBeLessThan(1);

  // 1. Поправка — как у core.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  const shown = await expectFixMatchesCore(page, 4, core);
  await expect(fixLine(page, 4)).toContainText(/^Экспозиция \+0\.\d\d EV/);

  // «Применить»: плитка уходит из списка, в main — предложенная экспозиция, core видит сетку в допуске.
  await fixLine(page, 4).getByTestId('apply-fix').click();
  await expect(page.getByTestId('outliers-none')).toBeVisible();
  await expect.poll(async () => (await mainProject(page))?.slots[4]?.adjust.exposure).toBe(shown.value);
  const fixed = await coreState(page, projectDir);
  expect(fixed.analysis.outliers).toEqual([]);
  const L = fixed.analysis.expectations.find((e) => e.index === 4)!.parts.find((p) => p.reason === 'L')!;
  expect(Math.abs(L.value - L.expected)).toBeLessThan(0.01);

  // Режим 7: у плитки 5 значение меньше 1, как у core.
  await page.keyboard.press('Digit7');
  const d = await deviationOf(page, 4);
  expect(d).toBeLessThan(1);
  expect(Math.abs(d - fixed.analysis.expectations.find((e) => e.index === 4)!.deviation)).toBeLessThan(0.15);

  // Одна ⌘Z возвращает прежнее: экспозиция 0, выброс и та же поправка; ⌘⇧Z — снова применена.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[4]?.adjust.exposure).toBe(0);
  await expect(fixLine(page, 4)).toHaveAttribute('data-state', 'fix');
  expect((await shownFix(fixLine(page, 4))).value).toBe(shown.value);
  expect(await deviationOf(page, 4)).toBeGreaterThan(1);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[4]?.adjust.exposure).toBe(shown.value);
  await expect(page.getByTestId('outliers-none')).toBeVisible();

  // 4. Выход без ожидания автосохранения и открытие: поправка на месте, плитки в допуске.
  await quit();
  const reopened = await openProject(projectDir, 9);
  expect((await mainProject(reopened))?.slots[4]?.adjust.exposure).toBe(shown.value);
  await reopened.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(reopened, 9);
  await expect(reopened.getByTestId('outliers-none')).toBeVisible();

  // 3. Экспозиция плитки 5 — −1: до ожидания нужно больше 1 EV. «Заменить» с лучшим L в лимите, без кнопки.
  await quit();
  await editProjectFile(projectDir, (project) => {
    project.slots[4]!.adjust.exposure = -1;
  });
  const dark = await openProject(projectDir, 9);
  const far = await coreState(dark, projectDir);
  expect(reasonsByIndex(far.analysis)).toEqual([[4, ['L']]]);
  const replace = coreFix(far, 4);
  expect(replace).toMatchObject({ replace: true, exact: false, value: 0, range: [-2, 0] });
  await dark.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(dark, 9);
  const shownReplace = await expectFixMatchesCore(dark, 4, replace);
  expect(Math.abs(shownReplace.reached - replace.reached)).toBeLessThan(0.005);
  // Лучшее в лимите — L плитки при экспозиции 0, как до правки.
  const L0 = before.analysis.expectations.find((e) => e.index === 4)!.parts.find((p) => p.reason === 'L')!.value;
  expect(Math.abs(shownReplace.reached - L0)).toBeLessThan(0.005);
  expect(shownReplace.text).toMatch(/^Заменить · в пределах лимита — яркость 0\.\d\d$/);
});

test('холодная сетка: «Температура −N» в пределах 20, «Тон» в сектор, блёклая — «заменить», опубликованная', async () => {
  // Проект 4в: девять плиток тона 205° с хромой 0.05 шахматкой по светлоте. Плитка 3 сдвинута по оси температуры,
  // у плитки 6 хрома вдвое меньше, плитка 7 отведена по тону на 22° — за край сектора i, но в пределах ±30° HSL.
  const HUE = 205;
  const CHROMA = 0.05;
  const a0 = CHROMA * Math.cos((HUE * Math.PI) / 180);
  const b0 = CHROMA * Math.sin((HUE * Math.PI) / 180);
  const [ua, ub] = TEMPERATURE_AXIS;
  const warm = { a: a0 + ua * 0.013, b: b0 + ub * 0.013 };
  const colors = LEVELS.map((L) => lch(L, CHROMA, HUE));
  colors[2] = lch(LEVELS[2]!, meanChroma(warm.a, warm.b), meanHue(warm.a, warm.b));
  colors[5] = lch(LEVELS[5]!, CHROMA / 2, HUE);
  colors[6] = lch(LEVELS[6]!, CHROMA * 0.92, HUE + 22);

  const projectDir = join(root, 'Холодная');
  const page = await createProject(projectDir, await solidPhotos(join(root, 'cold'), colors));
  const before = await coreState(page, projectDir);
  const reasons = Object.fromEntries(reasonsByIndex(before.analysis));
  expect(reasons[2]).toEqual(['temperature']);
  expect(reasons[5]?.[0]).toBe('chroma');
  expect(reasons[6]).toEqual(['hue']);
  expect(Object.keys(reasons).map(Number).sort()).toEqual([2, 5, 6]);
  const temp = coreFix(before, 2);
  const pale = coreFix(before, 5);
  const hue = coreFix(before, 6);
  expect(temp).toMatchObject({ slider: 'temp', exact: true, replace: false });
  expect(temp.value).toBeLessThan(0);
  expect(temp.value).toBeGreaterThanOrEqual(-20);
  // Блёклой нужна хрома ×2 — за ±30 насыщенности.
  expect(pale).toMatchObject({ slider: 'saturation', replace: true, value: 30 });
  expect(hue).toMatchObject({ slider: 'hslHue', exact: true, replace: false, bands: ['aqua', 'blue'] });

  // 2. Поправки — как у core.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  const shownTemp = await expectFixMatchesCore(page, 2, temp);
  await expect(fixLine(page, 2)).toContainText(/^Температура −\d+/);
  await expectFixMatchesCore(page, 5, pale);
  await expect(fixLine(page, 5)).toContainText(/^Заменить · в пределах лимита — насыщенность 0\.\d{3}$/);
  const shownHue = await expectFixMatchesCore(page, 6, hue);
  await expect(fixLine(page, 6)).toContainText(/^Тон −\d+ · голубой и синий/);

  // «Применить» тон: оба диапазона одной записью, точка плитки 7 — внутри секторов, плитка уходит из списка.
  // Сначала тон: сектор i прижат краем к тёплой плитке 3, а её поправка температуры двигает и тон — после
  // неё сектор сам доходит до плитки 7 и та перестаёт быть выбросом (см. журнал, «Находки»).
  const slot7 = (await mainProject(page))!.slots[6]!;
  await fixLine(page, 6).getByTestId('apply-fix').click();
  await expect.poll(() => outlierIndices(page)).toEqual([2, 5]);
  await expect.poll(async () => (await mainProject(page))?.slots[6]?.adjust.hsl.blue.hue).toBe(shownHue.value);
  expect((await mainProject(page))?.slots[6]?.adjust.hsl.aqua.hue).toBe(shownHue.value);
  const point = page.locator(`[data-testid="harmony-point"][data-slot-id="${slot7.id}"]`);
  await expect(point).toHaveAttribute('data-outside', 'false');

  // Одна ⌘Z снимает тон с обоих диапазонов, ⌘⇧Z возвращает.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[6]?.adjust.hsl).toMatchObject({ aqua: { hue: 0 }, blue: { hue: 0 } });
  await expect.poll(() => outlierIndices(page)).toEqual([2, 5, 6]);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[6]?.adjust.hsl.blue.hue).toBe(shownHue.value);
  await expect.poll(() => outlierIndices(page)).toEqual([2, 5]);

  // «Применить» температуру: плитка 3 уходит из списка.
  await expect(fixLine(page, 2)).toHaveAttribute('data-state', 'fix');
  expect((await shownFix(fixLine(page, 2))).value).toBe(shownTemp.value);
  await fixLine(page, 2).getByTestId('apply-fix').click();
  await expect.poll(() => outlierIndices(page)).toEqual([5]);
  await expect.poll(async () => (await mainProject(page))?.slots[2]?.adjust.temp).toBe(shownTemp.value);
  await expect(point).toHaveAttribute('data-outside', 'false');
  const after = await coreState(page, projectDir);
  expect(reasonsByIndex(after.analysis).map(([index]) => index)).toEqual([5]);
  const harmony = after.analysis.metrics?.harmony;
  if (harmony?.kind !== 'template') throw new Error('core: ожидался шаблон');
  expect(harmony.tiles[6]!.distance).toBe(0);

  // 3–4. Выход без ожидания автосохранения; блёклая плитка опубликована: «опубликован, не правится».
  // Поправки температуры и тона на месте: в списке только блёклая.
  await quit();
  await editProjectFile(projectDir, (project) => {
    project.slots[5]!.state = 'published';
  });
  const reopened = await openProject(projectDir, 9);
  const published = await coreState(reopened, projectDir);
  expect(reasonsByIndex(published.analysis).map(([index]) => index)).toEqual([5]);
  expect(published.analysis.outliers[0]!.published).toBe(true);
  await reopened.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(reopened, 9);
  await expect.poll(() => outlierIndices(reopened)).toEqual([5]);
  await expect(fixLine(reopened, 5)).toHaveAttribute('data-state', 'published');
  await expect(fixLine(reopened, 5)).toHaveText('опубликован, не правится');
  await expect(reopened.getByTestId('apply-fix')).toHaveCount(0);
});

test('зелёная сетка: блёклая — «Насыщенность +N» в пределах 30, после применения в допуске', async () => {
  // Тон — вдоль оси оттенка: хрома плитки меняется, а её температура нет, и у блёклой одна причина.
  // Светлота всех плиток разная: одинаковые файлы импорт считает одним фото.
  const HUE = (Math.atan2(TINT_AXIS[1], TINT_AXIS[0]) * 180) / Math.PI + 180;
  const levels = [0.8, 0.55, 0.824, 0.562, 0.812, 0.538, 0.776, 0.526, 0.788];
  const colors = levels.map((L) => lch(L, 0.1, HUE));
  colors[4] = lch(levels[4]!, 0.08, HUE);
  const projectDir = join(root, 'Зелёная');
  const page = await createProject(projectDir, await solidPhotos(join(root, 'green'), colors));
  const before = await coreState(page, projectDir);
  expect(reasonsByIndex(before.analysis)).toEqual([[4, ['chroma']]]);
  const core = coreFix(before, 4);
  expect(core).toMatchObject({ slider: 'saturation', exact: true, replace: false });
  expect(core.value).toBeGreaterThan(15);
  expect(core.value).toBeLessThanOrEqual(30);

  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  const shown = await expectFixMatchesCore(page, 4, core);
  await expect(fixLine(page, 4)).toContainText(/^Насыщенность \+\d+/);
  await fixLine(page, 4).getByTestId('apply-fix').click();
  await expect(page.getByTestId('outliers-none')).toBeVisible();
  await expect.poll(async () => (await mainProject(page))?.slots[4]?.adjust.saturation).toBe(shown.value);
  const after = await coreState(page, projectDir);
  expect(after.analysis.outliers).toEqual([]);
});
