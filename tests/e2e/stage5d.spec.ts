// Критерий этапа 5г: у каждой позиции с фото есть стоимость попадания в цель; «Подогнать» предлагает перестановку
// подвижных фото и фазу паттерна с наименьшей суммой; «Переставить» — одна запись истории, опубликованные,
// закреплённые и зафиксированные не двигаются; оставшиеся отклонения получают поправки к цели с «Применить» и
// «Применить все», недостижимые — «заменить». docs/decisions/0025-fit.md. Подгонка, поправки и анализ сверяются
// с core по проекту из main и тем же прокси 512.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { findFix, searchWindow, type TileFix } from '../../src/core/harmony/fixes';
import type { RgbaImage } from '../../src/core/image/sample';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, windowRgb, type TileMetrics } from '../../src/core/metrics/tile';
import { DEFAULT_LEVELS } from '../../src/core/pattern/levels';
import { fitGrid, type GridFit } from '../../src/core/pattern/fit';
import { rotatePattern, targetAt, withPatternTargets } from '../../src/core/pattern/pattern';
import { stringPattern } from '../../src/core/pattern/string';
import type { Pattern, Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e5d-'));
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
/** Стоимость и отклонение — в долях допуска: шум декодера (L ±0.005), делённый на допуск цели 0.06. */
const RATIO_TOLERANCE = 0.15;
/** Значение экспозиции панели против поиска core по тому же прокси. */
const EV_TOLERANCE = 0.02 + 1e-9;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/**
 * Проект 1 под LDL/DLD (светлые позиции 0, 2, 4, 6, 8): 5 светлых и 4 тёмных вперемешку. Светлые 192, 186 и 195
 * стоят на тёмных позициях, тёмные 84, 40 и 100 — на светлых. После подгонки:
 * - 165 (L 0.72) на светлой позиции — «Экспозиция +0.4 EV»;
 * - 100 (L 0.50) на тёмной — «Экспозиция −0.6 EV»;
 * - 40 (L 0.28) на тёмной — до цели больше 1 EV: «заменить».
 * Фаза прежняя: в фазе 1 светлых позиций четыре, и одно светлое фото пришлось бы ставить на тёмную.
 * Все разные: одинаковые фото импорт считает одним.
 */
const MIXED = [189, 82, 84, 192, 165, 186, 40, 195, 100].map(gray);
/**
 * Проект 2: 4 светлых и 5 тёмных. Плитка 2 (светлая) зафиксирована, плитка 9 (тёмная) опубликована — обе
 * на своих местах только в фазе 1, где сетка начинается с тёмного. 168 (L 0.73) после подгонки — поправка.
 */
const PHASED = [81, 193, 190, 83, 168, 85, 79, 187, 87].map(gray);

function ldlDld(): Pattern {
  const result = stringPattern('LDL/DLD', DEFAULT_LEVELS);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
}

async function solidPhotos(dir: string, colors: readonly Rgb[]): Promise<string[]> {
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(dir, `${i + 1}`, W, H, () => color));
  return files;
}

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

async function editProjectFile(dir: string, change: (project: Project) => void): Promise<void> {
  const file = join(dir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  change(project);
  await writeFile(file, JSON.stringify(project, null, 2));
}

interface CoreState {
  project: Project;
  features: Record<string, TileMetrics>;
  analysis: GridAnalysis;
  fit: GridFit;
}

/** Проект из main, признаки core по тем же прокси 512 с поправкой фото и кадром слота, анализ и подгонка core. */
async function coreState(page: Page, projectDir: string, images: Map<string, RgbaImage>): Promise<CoreState> {
  const project = (await mainProject(page)) as Project;
  const features: Record<string, TileMetrics> = {};
  for (const slot of project.slots) {
    if (!slot.assetId) continue;
    if (!images.has(slot.assetId)) images.set(slot.assetId, await readProxyImage(projectDir, slot.assetId));
    features[slot.id] = tileMetrics(images.get(slot.assetId)!, slot.crop, project.grid.ratio, { photo: slot.adjust });
  }
  const fit = fitGrid(project, features);
  if (fit.kind !== 'fit') throw new Error(`core: подгонки нет (${fit.kind})`);
  return { project, features, analysis: analyzeGrid(project, features), fit };
}

/** Поиск core для выброса в позиции index — как в воркере, по худшей причине. */
function coreFix({ project, analysis }: CoreState, images: Map<string, RgbaImage>, index: number): TileFix {
  const outlier = analysis.outliers.find((o) => o.index === index);
  if (!outlier) throw new Error(`core: плитка ${index + 1} не выброс`);
  const slot = project.slots[index]!;
  const { reason, value, expected, tolerance } = outlier.reasons[0]!;
  const window = searchWindow(windowRgb(images.get(slot.assetId!)!, slot.crop, project.grid.ratio), project.grid.ratio);
  return findFix(window, { photo: slot.adjust }, { reason, value, expected, tolerance, source: outlier.source });
}

/** Раздел «Подгонка» готов и совпадает с core: стоимость каждой позиции, суммы, перестановка и фаза. */
async function expectFitMatchesCore(page: Page, fit: GridFit): Promise<void> {
  const section = page.getByTestId('fit');
  await expect(section).toHaveAttribute('data-state', 'ready');
  await expect(section).toHaveAttribute('data-order', fit.order.join(' '));
  await expect(section).toHaveAttribute('data-shift', String(fit.shift));
  await expect(section).toHaveAttribute('data-moved', String(fit.moved));
  const cells = page.getByTestId('fit-cell');
  await expect(cells).toHaveCount(fit.positions.length);
  const shown = await cells.evaluateAll((els) =>
    els.map((el) => ({
      role: el.getAttribute('data-role'),
      cost: el.hasAttribute('data-cost') ? Number(el.getAttribute('data-cost')) : null,
      to: Number(el.getAttribute('data-to')),
    })),
  );
  fit.positions.forEach((p, i) => {
    const cell = shown[i]!;
    expect(cell.role, `позиция ${i + 1}`).toBe(p.role);
    expect(cell.to, `позиция ${i + 1}`).toBe(p.to);
    if (p.cost === null) expect(cell.cost, `позиция ${i + 1}`).toBeNull();
    else expect(Math.abs(cell.cost! - p.cost), `позиция ${i + 1}: ${cell.cost}, core ${p.cost}`).toBeLessThan(RATIO_TOLERANCE);
  });
  const before = Number(await section.getAttribute('data-before'));
  const after = Number(await section.getAttribute('data-after'));
  const costs = fit.positions.filter((p) => p.cost !== null).length;
  expect(Math.abs(before - fit.before)).toBeLessThan(RATIO_TOLERANCE * costs);
  expect(Math.abs(after - fit.after)).toBeLessThan(RATIO_TOLERANCE * costs);
}

/** Режим 7: у каждой плитки с ожиданием — источник и отклонение core. */
async function expectDeviationMatchesCore(page: Page, expected: GridAnalysis): Promise<void> {
  const tiles = page.getByTestId('tile');
  for (const e of expected.expectations) {
    const fill = tiles.nth(e.index).getByTestId('tile-fill');
    await expect(fill, `плитка ${e.index + 1}`).toHaveAttribute('data-kind', 'deviation');
    await expect(fill, `плитка ${e.index + 1}`).toHaveAttribute('data-source', e.source);
    await expect
      .poll(async () => Math.abs(Number(await fill.getAttribute('data-value')) - e.deviation), { message: `плитка ${e.index + 1}` })
      .toBeLessThan(RATIO_TOLERANCE);
  }
}

/** Строка поправки под выбросом в позиции index (раздел «Поправки к цели»). */
function fixLine(page: Page, index: number): Locator {
  return page
    .getByTestId('target-fixes')
    .locator('li.outlier-row', { has: page.locator(`[data-testid="outlier"][data-index="${index}"]`) })
    .getByTestId('outlier-fix');
}

/** Поправка панели совпадает с поиском core: экспозиция, значение, «заменить». */
async function expectFixMatchesCore(page: Page, index: number, core: TileFix): Promise<number> {
  const line = fixLine(page, index);
  await expect(line).toHaveAttribute('data-state', core.replace ? 'replace' : 'fix');
  await expect(line).toHaveAttribute('data-slider', core.slider);
  const value = Number(await line.getAttribute('data-value'));
  expect(Math.abs(value - core.value), `плитка ${index + 1}: ${value}, core ${core.value}`).toBeLessThanOrEqual(EV_TOLERANCE);
  await expect(line.getByTestId('apply-fix')).toHaveCount(core.replace ? 0 : 1);
  return value;
}

/** Позиции выбросов раздела «Поправки к цели», по возрастанию. */
async function targetOutliers(page: Page): Promise<number[]> {
  const indices = await page
    .getByTestId('target-fixes')
    .getByTestId('outlier')
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-index'))));
  return indices.sort((a, b) => a - b);
}

const ids = (project: Project | undefined) => project?.slots.map((slot) => slot.id) ?? [];
const exposures = (project: Project | undefined) => project?.slots.map((slot) => slot.adjust.exposure) ?? [];

test('подгонка: стоимость позиций, перестановка и фаза как у core, «Переставить» и «Применить все» одной записью, перезапуск', async () => {
  const images = new Map<string, RgbaImage>();

  // 1. Девять серых вперемешку, паттерн LDL/DLD из 5б: стоимость каждой позиции и сумма — как у core,
  //    перестановка и фаза — как fitGrid core.
  const projectDir = join(root, 'Подгонка');
  let page = await createProject(projectDir, await solidPhotos(join(root, 'mixed'), MIXED));
  const tiles = page.getByTestId('tile');
  await page.getByRole('tab', { name: 'Цель' }).click();
  const panel = page.getByTestId('target-panel');
  await expect(panel.getByTestId('fit')).toHaveAttribute('data-state', 'none');
  await panel.getByRole('button', { name: 'Строка', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Строка-шаблон' }).fill('LDL/DLD');
  await panel.getByRole('button', { name: 'Применить к сетке' }).click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(ldlDld());

  let core = await coreState(page, projectDir, images);
  const initial = core.project;
  // Светлые фото уезжают на светлые позиции к ближайшей, тёмные — на тёмные; фаза прежняя.
  expect(core.fit.shift).toBe(0);
  expect(core.fit.moved).toBe(6);
  expect(core.fit.order).toEqual([0, 1, 3, 2, 4, 6, 5, 8, 7].map((i) => initial.slots[i]!.id));
  expect(core.fit.after).toBeLessThan(core.fit.before / 2);
  await expectFitMatchesCore(page, core.fit);
  await expect(panel.getByTestId('fit-shift')).toHaveText('нынешняя');
  await expect(panel.getByTestId('fit-moved')).toHaveText('6 фото');
  const proposed = core.fit.order;

  // 2. «Переставить»: порядок в main — предложенный, цели — по позициям; подгонка и режим 7 — как у core
  //    после перестановки. Одна ⌘Z возвращает порядок, ⌘⇧Z — снова.
  await panel.getByRole('button', { name: 'Переставить' }).click();
  await expect.poll(async () => ids(await mainProject(page))).toEqual(proposed);
  const fitted = (await mainProject(page))!;
  expect(fitted.slots.map((slot) => slot.target)).toEqual(fitted.slots.map((_, i) => targetAt(fitted.pattern!, i, 0)));
  core = await coreState(page, projectDir, images);
  expect(core.fit.moved).toBe(0);
  expect(core.fit.shift).toBe(0);
  await expectFitMatchesCore(page, core.fit);
  await expect(panel.getByRole('button', { name: 'Переставить' })).toBeDisabled();
  await expect(panel.getByTestId('fit')).toContainText('Сетка уже подогнана');
  await page.keyboard.press('Digit7');
  await expectDeviationMatchesCore(page, core.analysis);
  await page.keyboard.press('Digit2');
  await tiles.nth(4).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(initial.slots);
  await expect(panel.getByTestId('fit')).toHaveAttribute('data-order', proposed.join(' '));
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(fitted.slots);

  // 3. Поправки к цели: светлая плитка темнее цели — «Экспозиция +N EV», тёмная светлее — «−N EV», как findFix
  //    core; той, которой до цели больше 1 EV, — «Заменить — в подбор из библиотеки». «Применить все» — одна
  //    запись истории: в допуске все, кроме «заменить»; одна ⌘Z снимает все поправки.
  const fixes = page.getByTestId('target-fixes');
  await expect(fixes).toHaveAttribute('data-state', 'list');
  expect(core.analysis.outliers.map((o) => o.index).sort()).toEqual([4, 5, 7]);
  expect(core.analysis.outliers.every((o) => o.source === 'target')).toBe(true);
  await expect.poll(() => targetOutliers(page)).toEqual([4, 5, 7]);
  const lighter = coreFix(core, images, 4);
  const darker = coreFix(core, images, 7);
  const replace = coreFix(core, images, 5);
  expect(lighter).toMatchObject({ slider: 'exposure', replace: false, exact: true });
  expect(lighter.value).toBeGreaterThan(0.3);
  expect(darker).toMatchObject({ slider: 'exposure', replace: false, exact: true });
  expect(darker.value).toBeLessThan(-0.3);
  expect(replace).toMatchObject({ slider: 'exposure', replace: true, value: 1 });
  const up = await expectFixMatchesCore(page, 4, lighter);
  const down = await expectFixMatchesCore(page, 7, darker);
  await expectFixMatchesCore(page, 5, replace);
  await expect(fixLine(page, 4)).toContainText(/^Экспозиция \+0\.\d\d EV/);
  await expect(fixLine(page, 7)).toContainText(/^Экспозиция −0\.\d\d EV/);
  await expect(fixLine(page, 5)).toContainText('Заменить — в подбор из библиотеки (этап 6)');
  const applyAll = page.getByTestId('apply-all-fixes');
  await expect(applyAll).toHaveAttribute('data-count', '2');
  await applyAll.click();
  const applied = fitted.slots.map((slot, i) => (i === 4 ? up : i === 7 ? down : slot.adjust.exposure));
  await expect.poll(async () => exposures(await mainProject(page))).toEqual(applied);
  await expect.poll(() => targetOutliers(page)).toEqual([5]);
  await expect(applyAll).toBeDisabled();
  core = await coreState(page, projectDir, images);
  expect(core.analysis.outliers.map((o) => o.index)).toEqual([5]);
  const fixedProject = core.project;
  // Одна ⌘Z снимает обе поправки, ⌘⇧Z возвращает обе.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => exposures(await mainProject(page))).toEqual(exposures(fitted));
  await expect.poll(() => targetOutliers(page)).toEqual([4, 5, 7]);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(fixedProject.slots);

  // 4. Второй проект: 4 светлых и 5 тёмных, плитка 9 опубликована, у плитки 2 choiceLocked в project.json.
  //    Фаза 1 — шахматка начинается с тёмного; опубликованная и зафиксированная на месте; всё как у core.
  await quit();
  const phasedDir = join(root, 'Фаза');
  page = await createProject(phasedDir, await solidPhotos(join(root, 'phased'), PHASED));
  await quit();
  await editProjectFile(phasedDir, (project) => {
    project.pattern = ldlDld();
    project.slots[8]!.state = 'published';
    project.slots[1]!.choiceLocked = true;
    project.slots = withPatternTargets(project.slots, project.pattern, 0);
  });
  page = await openProject(phasedDir, 9);
  await page.getByRole('tab', { name: 'Цель' }).click();
  core = await coreState(page, phasedDir, images);
  const phasedBefore = core.project;
  expect(core.fit.shift).toBe(1);
  expect(core.fit.pattern).toEqual(rotatePattern(ldlDld(), 1));
  expect(core.fit.positions[1]?.role).toBe('locked');
  expect(core.fit.positions[8]?.role).toBe('published');
  expect(core.fit.order[1]).toBe(phasedBefore.slots[1]!.id);
  expect(core.fit.order[8]).toBe(phasedBefore.slots[8]!.id);
  expect(core.fit.order).toEqual([0, 1, 3, 2, 5, 4, 6, 7, 8].map((i) => phasedBefore.slots[i]!.id));
  await expectFitMatchesCore(page, core.fit);
  await expect(page.getByTestId('fit-shift')).toContainText('сдвиг на 1 позицию');
  await page.getByRole('button', { name: 'Переставить' }).click();
  await expect.poll(async () => ids(await mainProject(page))).toEqual(core.fit.order);
  const phased = (await mainProject(page))!;
  expect(phased.pattern).toEqual(core.fit.pattern);
  expect(phased.slots.map((slot) => slot.target?.L)).toEqual([0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44]);
  expect(phased.slots[8]?.state).toBe('published');
  expect(phased.slots[1]?.choiceLocked).toBe(true);
  core = await coreState(page, phasedDir, images);
  expect(core.fit.moved).toBe(0);
  expect(core.fit.shift).toBe(0);
  await expectFitMatchesCore(page, core.fit);
  // Одна ⌘Z возвращает и фазу, и порядок.
  await page.getByTestId('tile').nth(0).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => await mainProject(page)).toEqual(phasedBefore);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => await mainProject(page)).toEqual(phased);
  // Оставшееся отклонение — 168 на светлой позиции: «Применить все» — его поправка.
  expect(core.analysis.outliers.map((o) => o.index)).toEqual([5]);
  const phasedFix = coreFix(core, images, 5);
  const value = await expectFixMatchesCore(page, 5, phasedFix);
  await page.getByTestId('apply-all-fixes').click();
  await expect.poll(async () => (await mainProject(page))?.slots[5]?.adjust.exposure).toBe(value);
  await expect(page.getByTestId('target-fixes')).toContainText('Все плитки с целью в допуске');
  const final = (await mainProject(page))!;

  // 5. Выход без ожидания автосохранения и открытие: порядок, паттерн с фазой и поправки на месте.
  await quit();
  page = await openProject(phasedDir, 9);
  const reopened = (await mainProject(page))!;
  expect(reopened.slots).toEqual(final.slots);
  expect(reopened.pattern).toEqual(rotatePattern(ldlDld(), 1));
  await page.getByRole('tab', { name: 'Цель' }).click();
  await expect(page.getByTestId('fit')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('fit')).toHaveAttribute('data-moved', '0');
  await expect(page.getByTestId('target-fixes')).toContainText('Все плитки с целью в допуске');
});
