// Критерий этапа 5б: генератор и строка-шаблон дают паттерн, «Применить к сетке» пишет его и цели всех позиций
// одной записью истории; цели остаются на позициях при перестановке, вставке пустых и смене закреплённых; вкладка
// «Цель» показывает паттерн, устойчивость к сдвигу и цель выбранной позиции; режим 7 и «Выбросы» сверяют плитки
// с целями. docs/decisions/0023-patterns.md. Паттерн, цели и анализ сверяются с core по проекту из main и тем же
// прокси 512.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { RgbaImage } from '../../src/core/image/sample';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import { DEFAULT_GENERATOR, generatePattern } from '../../src/core/pattern/generator';
import { DEFAULT_LEVELS, HARD_TOLERANCE } from '../../src/core/pattern/levels';
import { targetAt } from '../../src/core/pattern/pattern';
import { stringPattern } from '../../src/core/pattern/string';
import type { Pattern, Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e5b-'));
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
/** Отклонение в долях допуска: шум декодера (L ±0.005), делённый на допуск цели. */
const RATIO_TOLERANCE = 0.15;
/** Сколько ждать, чтобы убедиться, что действие ничего не изменило. */
const SETTLE_MS = 400;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/**
 * 9 серых под LDL/DLD (L 0.80 — около 189 из 255, D 0.44 — около 82): все близко к цели своей позиции, кроме
 * плитки 3 (светлая позиция, 150 — L 0.67, около 2 допусков) и плитки 6 (тёмная, 130 — L 0.61, около 3 допусков).
 * Все разные: одинаковые фото импорт считает одним.
 */
const COLORS = [192, 84, 150, 80, 186, 130, 195, 78, 188].map(gray);

function corePattern(text: string): Pattern {
  const result = stringPattern(text, DEFAULT_LEVELS);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
}

/** Цели в main — ровно клетки паттерна по позициям; у закреплённых — нет. */
function expectTargetsByPosition(project: Project): void {
  const pattern = project.pattern;
  if (!pattern) throw new Error('в main нет паттерна');
  expect(project.slots.map((slot) => slot.target)).toEqual(project.slots.map((_, i) => targetAt(pattern, i, project.grid.pinned)));
}

/** Проект из main и признаки core по тем же прокси 512 — с поправкой фото и кадром каждого слота. */
async function coreAnalysis(page: Page, projectDir: string, images: Map<string, RgbaImage>): Promise<{ project: Project; analysis: GridAnalysis }> {
  const project = (await mainProject(page)) as Project;
  const bySlot: Record<string, TileMetrics> = {};
  for (const slot of project.slots) {
    if (!slot.assetId) continue;
    if (!images.has(slot.assetId)) images.set(slot.assetId, await readProxyImage(projectDir, slot.assetId));
    bySlot[slot.id] = tileMetrics(images.get(slot.assetId)!, slot.crop, project.grid.ratio, { photo: slot.adjust });
  }
  return { project, analysis: analyzeGrid(project, bySlot) };
}

/** Режим 7: у каждой плитки с ожиданием — источник и отклонение core; у плиток без ожидания заливки отклонения нет. */
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

/** Ждёт, пока все плитки посчитаны: хода «посчитано N из M» нет. */
async function expectMeasured(page: Page, measured: number): Promise<void> {
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', String(measured));
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
}

/** L клеток превью периода. */
function previewL(page: Page): Promise<number[]> {
  return page.getByTestId('pattern-cell').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-l'))));
}

test('паттерн: строка и генератор → цели позиций, режим 7 и выбросы по целям, перестановки, отмена и перезапуск', async () => {
  const files = [];
  for (const [i, color] of COLORS.entries()) files.push(await writePixelFixture(join(root, 'photos'), `${i + 1}`, W, H, () => color));
  const projectDir = join(root, 'Паттерн');
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 9');
  const ids = await expectTilesRendered(page, 9);
  const tiles = page.getByTestId('tile');
  const images = new Map<string, RgbaImage>();
  const order = (project: Project | undefined) => project?.slots.map((slot) => slot.assetId ?? slot.id) ?? [];

  // 1. «Цель» → «Строка», LDL/DLD: превью периода 3 × 2 и «Переживает одиночные посты».
  await page.getByRole('tab', { name: 'Цель' }).click();
  const panel = page.getByTestId('target-panel');
  await expect(panel.getByTestId('current-pattern')).toHaveAttribute('data-state', 'none');
  await panel.getByRole('button', { name: 'Строка', exact: true }).click();
  const input = panel.getByRole('textbox', { name: 'Строка-шаблон' });
  await input.fill('LDL/DLD');
  const checker = corePattern('LDL/DLD');
  await expect(panel.getByTestId('pattern-preview')).toHaveAttribute('data-rows', '2');
  expect(await previewL(page)).toEqual(checker.cells.map((cell) => cell.L));
  await expect(panel.getByTestId('pattern-mode')).toHaveAttribute('data-mode', 'single');
  await expect(panel.getByTestId('pattern-mode')).toContainText('Переживает одиночные посты');
  // До «Применить» проект не меняется: черновик — состояние интерфейса.
  expect((await mainProject(page))?.pattern).toBeUndefined();

  const apply = panel.getByRole('button', { name: 'Применить к сетке' });
  await apply.click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(checker);
  const applied = (await mainProject(page))!;
  expect(applied.pattern).toMatchObject({ source: 'string', periodRows: 2, postingMode: 'single' });
  expectTargetsByPosition(applied);
  expect(applied.slots.map((slot) => slot.target?.L)).toEqual([0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8]);
  await expect(panel.getByTestId('current-pattern')).toHaveAttribute('data-source', 'string');
  await expect(panel.getByTestId('current-pattern')).toHaveAttribute('data-posting-mode', 'single');
  // Повторное «Применить» с тем же паттерном ничего не пишет: одна ⌘Z ниже снимает паттерн целиком.
  await apply.click();

  // «Позиция»: цель выбранной плитки — тёмная клетка периода, жёсткая.
  await tiles.nth(1).click();
  const position = panel.getByTestId('position-target');
  await expect(position).toHaveAttribute('data-state', 'target');
  await expect(position).toHaveAttribute('data-l', '0.44');
  await expect(position).toHaveAttribute('data-hard', 'true');
  await expect(position).toHaveAttribute('data-cell', '1');
  await expect(position).toContainText('жёсткая');

  // ⌘Z снимает паттерн и цели одной записью, ⌘⇧Z возвращает.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.pattern).toBeUndefined();
  expect((await mainProject(page))?.slots.some((slot) => slot.target !== undefined)).toBe(false);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(applied.slots);

  // 2. Режим 7: у всех плиток источник — цель, значения — как deviation core. «Выбросы» — плитки вне цели «по цели».
  await page.keyboard.press('Digit7');
  let state = await coreAnalysis(page, projectDir, images);
  expect(state.analysis.expectations).toHaveLength(9);
  expect(state.analysis.expectations.every((e) => e.source === 'target')).toBe(true);
  await expectDeviationMatchesCore(page, state.analysis);
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 9);
  expect(state.analysis.outliers.map((o) => o.index)).toEqual([5, 2]);
  const outliers = page.getByTestId('outlier');
  await expect(outliers).toHaveCount(2);
  expect(await outliers.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-index'))))).toEqual([5, 2]);
  for (const row of await outliers.all()) {
    await expect(row).toHaveAttribute('data-source', 'target');
    await expect(row).toContainText('по цели');
  }
  await page.getByRole('tab', { name: 'Цель' }).click();

  // 3. Shift+→ на плитке 1: цели по позициям, режим 7 — как у core для нового порядка; одна ⌘Z возвращает всё.
  await tiles.nth(0).click();
  await page.keyboard.press('Shift+ArrowRight');
  const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
  await expect.poll(async () => order(await mainProject(page))).toEqual(swapped);
  expectTargetsByPosition((await mainProject(page))!);
  state = await coreAnalysis(page, projectDir, images);
  // Светлое фото на тёмной позиции и наоборот — теперь выбросы.
  expect(state.analysis.outliers.map((o) => o.index).sort()).toEqual([0, 1, 2, 5]);
  await expectDeviationMatchesCore(page, state.analysis);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(applied.slots);

  // «+ Ряд пустых»: фото сдвинуты на ряд — их цели пересчитаны (L ↔ D), у пустых — цели своих позиций.
  await page.getByRole('button', { name: '+ Ряд пустых' }).click();
  await expect.poll(async () => (await mainProject(page))?.slots.length).toBe(12);
  const inserted = (await mainProject(page))!;
  expectTargetsByPosition(inserted);
  expect(inserted.slots.slice(3).map((slot) => slot.assetId)).toEqual(ids);
  expect(inserted.slots.slice(3).map((slot) => slot.target?.L)).toEqual([0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44]);
  // Пустая позиция с целью показывает образец цели.
  const swatches = page.getByTestId('tile-target');
  await expect(swatches).toHaveCount(3);
  expect(await swatches.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-l'))))).toEqual([0.8, 0.44, 0.8]);
  await tiles.nth(1).click();
  await expect(position).toHaveAttribute('data-l', '0.44');
  await expect(position).toContainText('Пустая позиция');
  state = await coreAnalysis(page, projectDir, images);
  await expectDeviationMatchesCore(page, state.analysis);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots).toEqual(applied.slots);
  await expect(swatches).toHaveCount(0);

  // «Закреплено: 1»: у позиции 1 цели нет, в режиме 7 — «закреплён»; одна ⌘Z возвращает и закреплённых, и цель.
  await page.getByLabel('Закреплено').selectOption('1');
  await expect.poll(async () => (await mainProject(page))?.grid.pinned).toBe(1);
  const pinned = (await mainProject(page))!;
  expectTargetsByPosition(pinned);
  expect(pinned.slots[0]?.target).toBeUndefined();
  expect(pinned.slots.slice(1)).toEqual(applied.slots.slice(1));
  await expect(tiles.nth(0).getByTestId('tile-fill')).toHaveText('закреплён');
  await tiles.nth(0).click();
  await expect(position).toHaveAttribute('data-state', 'pinned');
  await tiles.nth(4).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.grid.pinned).toBe(0);
  expect((await mainProject(page))?.slots).toEqual(applied.slots);
  await page.keyboard.press('Digit2');

  // 4. Генератор «Полосы по строкам», 2 уровня: «Публиковать пачками по 3»; клетки и postingMode — как у core.
  await panel.getByRole('button', { name: 'Генератор' }).click();
  await panel.getByLabel('Шаблон').selectOption('rows');
  await panel.getByLabel('Уровней').selectOption('2');
  const rows = generatePattern({ ...DEFAULT_GENERATOR, template: 'rows', levels: 2 }, DEFAULT_LEVELS);
  await expect(panel.getByTestId('pattern-mode')).toHaveAttribute('data-mode', 'batch');
  await expect(panel.getByTestId('pattern-mode')).toContainText('Публиковать пачками по 3');
  expect(await previewL(page)).toEqual(rows.cells.map((cell) => cell.L));
  await apply.click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(rows);
  expect(rows.postingMode).toBe('batch');
  expectTargetsByPosition((await mainProject(page))!);

  // «Шахматка» с цветом уровней: тон и хрома в целях, допуски жёсткие.
  await panel.getByLabel('Шаблон').selectOption('checker');
  await panel.getByRole('checkbox', { name: 'Цвет L' }).check();
  await panel.getByRole('spinbutton', { name: 'Цвет L: тон' }).fill('60');
  await panel.getByRole('checkbox', { name: 'Цвет D' }).check();
  await panel.getByRole('spinbutton', { name: 'Цвет D: тон' }).fill('240');
  await panel.getByRole('spinbutton', { name: 'Цвет D: хрома' }).fill('0.04');
  const colored = generatePattern(
    { ...DEFAULT_GENERATOR, template: 'checker', colors: { L: { hue: 60, chroma: 0.05 }, D: { hue: 240, chroma: 0.04 } } },
    DEFAULT_LEVELS,
  );
  await expect(panel.getByTestId('pattern-mode')).toHaveAttribute('data-mode', 'single');
  await apply.click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(colored);
  const coloredProject = (await mainProject(page))!;
  expectTargetsByPosition(coloredProject);
  expect(coloredProject.slots.map((slot) => [slot.target?.hue, slot.target?.chroma])).toEqual(
    Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? [60, 0.05] : [240, 0.04])),
  );
  expect(coloredProject.slots.every((slot) => slot.target?.hard && JSON.stringify(slot.target.tolerance) === JSON.stringify(HARD_TOLERANCE))).toBe(
    true,
  );
  await tiles.nth(1).click();
  await expect(position).toHaveAttribute('data-hue', '240');
  await expect(position).toHaveAttribute('data-chroma', '0.04');
  // Режим 7 с цветом цели — как у core: серые плитки тон почти не весят, хрома — да.
  await page.keyboard.press('Digit7');
  state = await coreAnalysis(page, projectDir, images);
  await expectDeviationMatchesCore(page, state.analysis);
  await page.keyboard.press('Digit2');

  // 5. Строка LXL/DL — ошибка с рядом и символом, «Применить» недоступно, проект не меняется.
  await panel.getByRole('button', { name: 'Строка', exact: true }).click();
  await input.fill('LXL/DL');
  const error = panel.getByTestId('pattern-error');
  await expect(error).toContainText('Ряд 1');
  await expect(error).toContainText('символ 2');
  await expect(error).toContainText('«X»');
  await expect(apply).toBeDisabled();
  await expect(panel.getByTestId('pattern-preview')).toHaveCount(0);
  await page.waitForTimeout(SETTLE_MS);
  expect(await mainProject(page)).toEqual(coloredProject);

  // «Убрать цели» — паттерна и целей нет, режим 7 снова считает от сетки; одна ⌘Z возвращает их.
  await panel.getByRole('button', { name: 'Убрать цели' }).click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toBeUndefined();
  expect((await mainProject(page))?.slots.some((slot) => 'target' in slot)).toBe(false);
  await expect(panel.getByTestId('current-pattern')).toHaveAttribute('data-state', 'none');
  await page.keyboard.press('Digit7');
  state = await coreAnalysis(page, projectDir, images);
  expect(state.analysis.expectations.every((e) => e.source === 'grid')).toBe(true);
  expect(state.analysis.expectations).toHaveLength(9);
  await expectDeviationMatchesCore(page, state.analysis);
  await page.keyboard.press('Digit2');
  await tiles.nth(4).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => await mainProject(page)).toEqual(coloredProject);

  // 6. Выход без ожидания автосохранения и открытие: паттерн и цели на месте.
  await app.close();
  app = undefined;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, 9);
  const reopened = (await mainProject(page))!;
  expect(reopened.pattern).toEqual(colored);
  expect(reopened.slots).toEqual(coloredProject.slots);
  await page.getByRole('tab', { name: 'Цель' }).click();
  await expect(page.getByTestId('current-pattern')).toHaveAttribute('data-source', 'generator');
  await page.keyboard.press('Digit7');
  state = await coreAnalysis(page, projectDir, images);
  expect(state.analysis.expectations.every((e) => e.source === 'target')).toBe(true);
  await expectDeviationMatchesCore(page, state.analysis);
});
