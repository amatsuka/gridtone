// Критерий этапа 5а: позицию с фото можно отметить опубликованной и снять отметку — опубликованная не правится
// и не двигается; пустые позиции добавляются в начало ленты и удаляются, фото переносится в них; 0–3 закреплённых
// не двигаются, в анализ не входят и в порядке публикации идут последними; плитки показывают статус и номер
// публикации; всё отменяется и переживает перезапуск. docs/decisions/0022-statuses-empty-pinned.md.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { RgbaImage } from '../../src/core/image/sample';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import type { Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { launch, mainProject, press, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e5a-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Размер поста 3:4 — оригиналы не увеличиваются при экспорте. */
const W = 1080;
const H = 1440;
/** Допуск L между воркером (декодер Chromium) и core (sharp) по тому же прокси. */
const L_TOLERANCE = 0.005;
/** Отклонение в долях допуска: шум декодера, делённый на допуск. */
const RATIO_TOLERANCE = 0.15;
/** Сколько ждать, чтобы убедиться, что действие ничего не изменило. */
const SETTLE_MS = 400;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/**
 * Шахматка из 9 серых: светлые на чётных позициях, тёмные на нечётных. Плитка 1 светлее остальных светлых —
 * без закрепления она сдвинула бы медиану своего класса; плитка 5 темнее нужного — выброс «яркость».
 */
const COLORS = [240, 70, 196, 62, 160, 76, 214, 66, 200].map(gray);

/** Слот в порядке сетки: ассет у позиции с фото, id — у пустой. */
const positions = (project: Project | undefined) => project?.slots.map((slot) => slot.assetId ?? slot.id) ?? [];

/** То же по DOM: плитки на экране в их порядке. */
function screenPositions(page: Page): Promise<string[]> {
  return page.getByTestId('tile').evaluateAll((els) => els.map((el) => el.getAttribute('data-asset-id') ?? el.getAttribute('data-slot-id') ?? ''));
}

/** Номер публикации каждой плитки на экране; null — номера нет (опубликованный пост). */
function orders(page: Page): Promise<(string | null)[]> {
  return page.getByTestId('tile').evaluateAll((els) => els.map((el) => el.getAttribute('data-order')));
}

/** Ждёт, пока холст нарисует фото во всех плитках с фото. Пустые позиции не рисуются. */
async function expectPhotosRendered(page: Page, count: number): Promise<void> {
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(count);
  for (const tile of await tiles.all()) {
    if ((await tile.getAttribute('data-asset-id')) === null) continue;
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toHaveAttribute('data-rendered', 'true');
  }
}

/** Тянет плитку мышью с позиции from на позицию to. Обе плитки должны поместиться на экране. */
async function dragTile(page: Page, from: number, to: number): Promise<void> {
  const tiles = page.getByTestId('tile');
  await tiles.nth(from).scrollIntoViewIfNeeded();
  await tiles.nth(to).scrollIntoViewIfNeeded();
  const a = await tiles.nth(from).boundingBox();
  const b = await tiles.nth(to).boundingBox();
  if (!a || !b) throw new Error('плитка не видна');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Проект из main и признаки core по тем же прокси 512 — с поправкой фото и кадром каждого слота. */
async function coreState(
  page: Page,
  projectDir: string,
  images: Map<string, RgbaImage>,
): Promise<{ project: Project; bySlot: Record<string, TileMetrics> }> {
  const project = (await mainProject(page)) as Project;
  const bySlot: Record<string, TileMetrics> = {};
  for (const slot of project.slots) {
    if (!slot.assetId) continue;
    if (!images.has(slot.assetId)) images.set(slot.assetId, await readProxyImage(projectDir, slot.assetId));
    bySlot[slot.id] = tileMetrics(images.get(slot.assetId)!, slot.crop, project.grid.ratio, { photo: slot.adjust });
  }
  return { project, bySlot };
}

const num = async (locator: Locator, attribute: string) => Number(await locator.getAttribute(attribute));

/** Ждёт, пока все плитки посчитаны: хода «посчитано N из M» нет. measured — плиток в анализе, без закреплённых. */
async function expectMeasured(page: Page, measured: number): Promise<void> {
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', String(measured));
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
}

/** Числа вкладки «Анализ», которые зависят от состава анализа: ритм, сила, разброс, контраст, выбросы. */
interface PanelNumbers {
  rhythm: string;
  strength: number;
  spread: number;
  horizontal: number;
  vertical: number;
  outliers: { index: number; deviation: number; reasons: { reason: string; value: number; expected: number }[] }[];
}

async function panelNumbers(page: Page): Promise<PanelNumbers> {
  const rhythm = page.getByTestId('rhythm');
  const contrast = page.getByTestId('neighbor-contrast');
  return {
    rhythm: `${await rhythm.getAttribute('data-kind')}/${await rhythm.getAttribute('data-template')}`,
    strength: await num(rhythm, 'data-strength'),
    spread: await num(page.getByTestId('luma-spread'), 'data-value'),
    horizontal: await num(contrast, 'data-horizontal'),
    vertical: await num(contrast, 'data-vertical'),
    outliers: await page.getByTestId('outlier').evaluateAll((els) =>
      els.map((el) => ({
        index: Number(el.getAttribute('data-index')),
        deviation: Number(el.getAttribute('data-deviation')),
        reasons: [...el.querySelectorAll('[data-testid="outlier-reason"]')].map((r) => ({
          reason: r.getAttribute('data-reason') ?? '',
          value: Number(r.getAttribute('data-value')),
          expected: Number(r.getAttribute('data-expected')),
        })),
      })),
    ),
  };
}

/** Панель против core: ритм, сила, разброс, контраст соседей, выбросы с причинами и ожиданиями. */
function expectPanelMatchesCore(shown: PanelNumbers, expected: GridAnalysis): void {
  const metrics = expected.metrics;
  if (!metrics || metrics.rhythm.kind === 'flat') throw new Error('core: ожидался анализ сетки с ритмом');
  expect(shown.rhythm).toBe(`${metrics.rhythm.kind}/${metrics.rhythm.best.template}`);
  expect(Math.abs(shown.strength - metrics.rhythm.best.strength)).toBeLessThan(0.02);
  expect(Math.abs(shown.spread - metrics.spread)).toBeLessThan(0.003);
  expect(Math.abs(shown.horizontal - (metrics.contrast.horizontal ?? NaN))).toBeLessThan(0.003);
  expect(Math.abs(shown.vertical - (metrics.contrast.vertical ?? NaN))).toBeLessThan(0.003);
  expect(shown.outliers.map((o) => o.index)).toEqual(expected.outliers.map((o) => o.index));
  expected.outliers.forEach((core, i) => {
    const row = shown.outliers[i]!;
    expect(Math.abs(row.deviation - core.deviation), `выброс ${core.index + 1}`).toBeLessThan(RATIO_TOLERANCE);
    expect(row.reasons.map((r) => r.reason)).toEqual(core.reasons.map((r) => r.reason));
    core.reasons.forEach((part, j) => {
      expect(Math.abs(row.reasons[j]!.value - part.value), `выброс ${core.index + 1}, ${part.reason}`).toBeLessThan(L_TOLERANCE);
      expect(Math.abs(row.reasons[j]!.expected - part.expected), `выброс ${core.index + 1}, ожидание ${part.reason}`).toBeLessThan(L_TOLERANCE);
    });
  });
}

/** Режим 7: у плиток ленты — отклонение core, у закреплённой — «закреплён» без значения. */
async function expectDeviationMatchesCore(page: Page, expected: GridAnalysis): Promise<number[]> {
  const tiles = page.getByTestId('tile');
  const pinnedFill = tiles.nth(0).getByTestId('tile-fill');
  await expect(pinnedFill).toHaveAttribute('data-kind', 'no-target');
  await expect(pinnedFill).toHaveText('закреплён');
  expect(expected.expectations.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const values: number[] = [];
  for (const e of expected.expectations) {
    const fill = tiles.nth(e.index).getByTestId('tile-fill');
    await expect(fill).toHaveAttribute('data-kind', 'deviation');
    const value = Number(await fill.getAttribute('data-value'));
    expect(Math.abs(value - e.deviation), `плитка ${e.index + 1}: ${value}, core ${e.deviation}`).toBeLessThan(RATIO_TOLERANCE);
    values.push(value);
  }
  return values;
}

/** Нажимает «Экспортировать…» и ждёт итога. Возвращает новую подпапку. */
async function runExport(dialog: Locator): Promise<string> {
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true', { timeout: 120_000 });
  return (await result.getAttribute('data-dir')) ?? '';
}

test('статусы, пустые позиции и закреплённые: правки, порядок публикации, анализ, экспорт, отмена и перезапуск', async () => {
  const files = [];
  for (const [i, color] of COLORS.entries()) files.push(await writePixelFixture(join(root, 'photos'), `кадр ${i + 1}`, W, H, () => color));
  const projectDir = join(root, 'Лента');
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 9');
  await expectPhotosRendered(page, 9);
  const ids = positions(await mainProject(page));
  const [t1, t2, t3, t4, t5, t6, t7, t8, t9] = ids as [string, string, string, string, string, string, string, string, string];
  const tiles = page.getByTestId('tile');
  const images = new Map<string, RgbaImage>();

  // 1. Плитки 7–9 → «Опубликован»: статус в main, пометки, ползунки недоступны.
  await tiles.nth(6).click();
  await tiles.nth(8).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-testid="tile"][aria-selected="true"]')).toHaveCount(3);
  const published = page.getByRole('checkbox', { name: 'Опубликован' });
  await expect(published).not.toBeChecked();
  await published.check();
  const states = (project: Project | undefined) => project?.slots.map((slot) => slot.state);
  const planned6 = Array<string>(6).fill('planned');
  await expect.poll(async () => states(await mainProject(page))).toEqual([...planned6, 'published', 'published', 'published']);
  await expect(page.getByTestId('tile-published')).toHaveCount(3);
  for (const i of [6, 7, 8]) await expect(tiles.nth(i)).toHaveAttribute('data-state', 'published');
  await expect(page.getByRole('slider', { name: 'Экспозиция' })).toBeDisabled();
  // Номера публикации: снизу вверх по запланированным, у опубликованных номера нет.
  expect(await orders(page)).toEqual(['6', '5', '4', '3', '2', '1', null, null, null]);
  await expect(tiles.nth(5).getByTestId('tile-order')).toHaveText('1-й');

  // Shift+→ на плитке 6 ничего не меняет: дальше только опубликованные.
  await tiles.nth(5).click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(SETTLE_MS);
  expect(await screenPositions(page)).toEqual(ids);
  expect(positions(await mainProject(page))).toEqual(ids);
  // Перетаскивание опубликованной тоже ничего не меняет.
  await dragTile(page, 7, 0);
  await page.waitForTimeout(SETTLE_MS);
  expect(positions(await mainProject(page))).toEqual(ids);

  // ⌘Z снимает статус с трёх плиток одной записью, ⌘⇧Z возвращает.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => states(await mainProject(page))).toEqual(Array(9).fill('planned'));
  await expect(page.getByTestId('tile-published')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => states(await mainProject(page))).toEqual([...planned6, 'published', 'published', 'published']);

  // 2. «Закреплено: 1»: пометка, Shift+← на плитке 2 её не сдвигает, в порядке публикации она последняя.
  await page.getByLabel('Закреплено').selectOption('1');
  await expect.poll(async () => (await mainProject(page))?.grid.pinned).toBe(1);
  await expect(page.getByTestId('tile-pinned')).toHaveCount(1);
  await expect(tiles.nth(0)).toHaveAttribute('data-pinned', 'true');
  await tiles.nth(1).click();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(SETTLE_MS);
  expect(positions(await mainProject(page))).toEqual(ids);
  expect(await screenPositions(page)).toEqual(ids);
  expect(await orders(page)).toEqual(['6', '5', '4', '3', '2', '1', null, null, null]);
  await expect(tiles.nth(0)).toHaveAttribute('data-pin', 'true');
  await expect(tiles.nth(0).getByTestId('tile-order')).toHaveText('6-й · закрепить');

  // «Анализ» — как у core без закреплённой: в анализе 8 плиток, у закреплённой на карте пометка.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expectMeasured(page, 8);
  await expect(page.getByTestId('luma-cell').nth(0)).toHaveAttribute('data-pinned', 'true');
  const state = await coreState(page, projectDir, images);
  const expected = analyzeGrid(state.project, state.bySlot);
  expect(expected.outliers.map((o) => o.index)).toEqual([4]);
  const before = await panelNumbers(page);
  expectPanelMatchesCore(before, expected);
  // Без закрепления ожидание плитки 5 было бы другим: плитка 1 светлее остальных светлых.
  const unpinned = analyzeGrid({ ...state.project, grid: { ...state.project.grid, pinned: 0 } }, state.bySlot);
  const expectedL = expected.outliers[0]!.reasons[0]!.expected;
  const unpinnedL = unpinned.expectations.find((e) => e.index === 4)!.parts.find((part) => part.reason === 'L')!.expected;
  expect(Math.abs(expectedL - unpinnedL)).toBeGreaterThan(2 * L_TOLERANCE);
  // Режим 7: у ленты — отклонение core, у закреплённой — «закреплён».
  await page.keyboard.press('Digit7');
  const deviations = await expectDeviationMatchesCore(page, expected);

  // Экспозиция −2 на закреплённой: её клетка темнеет, анализ не меняется.
  const lumaCells = page.getByTestId('luma-cell');
  const pinnedL = await num(lumaCells.nth(0), 'data-l');
  await page.keyboard.press('Digit2');
  await tiles.nth(0).click();
  await page.getByRole('tab', { name: 'Фото' }).click();
  await press(page, 'Экспозиция', 'ArrowLeft', 40);
  await expect(page.getByTestId('value-exposure')).toHaveText('−2.00');
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expect.poll(async () => num(lumaCells.nth(0), 'data-l')).toBeLessThan(pinnedL - 0.1);
  await expectMeasured(page, 8);
  const after = await panelNumbers(page);
  expect(after).toEqual(before);
  const darkenedState = await coreState(page, projectDir, images);
  const darkened = analyzeGrid(darkenedState.project, darkenedState.bySlot);
  expect(darkened.cells[0]!.L).toBeLessThan(expected.cells[0]!.L! - 0.1);
  expect(darkened.metrics).toEqual(expected.metrics);
  expect(darkened.outliers).toEqual(expected.outliers);
  await page.keyboard.press('Digit7');
  expect(await expectDeviationMatchesCore(page, darkened)).toEqual(deviations);
  await page.keyboard.press('Digit2');
  console.log(
    `ожидание L плитки 5: ${expectedL.toFixed(3)} (без закрепления ${unpinnedL.toFixed(3)}); ` +
      `закреплённая L ${pinnedL.toFixed(3)} → ${(await num(lumaCells.nth(0), 'data-l')).toFixed(3)}`,
  );

  // 3. «+ Ряд пустых» — три пустых слота сразу после закреплённого, с новыми id; фото сдвинуты на ряд.
  await page.getByRole('button', { name: '+ Ряд пустых' }).click();
  await expect.poll(async () => (await mainProject(page))?.slots.length).toBe(12);
  const inserted = (await mainProject(page))!;
  const empties = inserted.slots.slice(1, 4);
  expect(empties.map((slot) => [slot.state, slot.assetId])).toEqual(Array(3).fill(['empty', undefined]));
  const [e1, e2, e3] = empties.map((slot) => slot.id) as [string, string, string];
  expect(new Set([...ids, e1, e2, e3]).size).toBe(12);
  expect(positions(inserted)).toEqual([t1, e1, e2, e3, t2, t3, t4, t5, t6, t7, t8, t9]);
  await expect(page.locator('[data-testid="tile"][data-state="empty"]')).toHaveCount(3);
  await expect(tiles.nth(1)).toContainText('Пусто');
  // Номера публикации — снизу вверх вместе с пустыми; закреплённая — последней.
  expect(await orders(page)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', null, null, null]);
  await expect(tiles.nth(0).getByTestId('tile-order')).toHaveText('9-й · закрепить');
  // ⌘Z убирает пустые, ⌘⇧Z возвращает их с теми же id.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => positions(await mainProject(page))).toEqual(ids);
  await expect(tiles).toHaveCount(9);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(async () => positions(await mainProject(page))).toEqual(positions(inserted));
  expect((await mainProject(page))?.slots.slice(1, 4)).toEqual(empties);

  // 4. Фото, перетащенное на пустую позицию, меняется с ней местами.
  await dragTile(page, 4, 1);
  const swapped = [t1, t2, e2, e3, e1, t3, t4, t5, t6, t7, t8, t9];
  await expect.poll(async () => positions(await mainProject(page))).toEqual(swapped);
  expect(await screenPositions(page)).toEqual(swapped);
  // Delete на выделенной пустой позиции удаляет её, на плитке с фото ничего не делает.
  await tiles.nth(4).click();
  await page.keyboard.press('Delete');
  const removed = [t1, t2, e2, e3, t3, t4, t5, t6, t7, t8, t9];
  await expect.poll(async () => positions(await mainProject(page))).toEqual(removed);
  await tiles.nth(4).click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(SETTLE_MS);
  expect(positions(await mainProject(page))).toEqual(removed);
  expect(await orders(page)).toEqual(['8', '7', '6', '5', '4', '3', '2', '1', null, null, null]);

  // 5. «Экспорт» → «Посты»: номера файлов — номера плана, пустые пропущены с оговоркой, закреплённый — последним.
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const section = dialog.getByTestId('posts-section');
  await section.getByRole('checkbox', { name: 'Посты', exact: true }).check();
  await expect(section.getByTestId('posts-count')).toContainText('6 постов к публикации');
  const note = 'Посты 5, 6 — пустые позиции: номера пропущены, файлов нет.';
  await expect(section.getByTestId('posts-note')).toHaveText([note]);
  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  const dir = await runExport(dialog);
  await expect(dialog.getByTestId('export-error')).toHaveCount(0);
  await expect(dialog.getByTestId('export-warning')).toHaveText([note]);
  expect((await readdir(dir)).sort()).toEqual(
    ['1 — кадр 6.jpg', '2 — кадр 5.jpg', '3 — кадр 4.jpg', '4 — кадр 3.jpg', '7 — кадр 2.jpg', '8 — кадр 1 (закрепить).jpg'].sort(),
  );
  await dialog.getByRole('button', { name: 'Закрыть' }).click();

  // 6. Выход без ожидания автосохранения и открытие: статусы, пустые позиции, закреплённые и порядок на месте.
  const final = (await mainProject(page))!;
  await app.close();
  app = undefined;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectPhotosRendered(page, 11);
  const reopened = (await mainProject(page))!;
  expect(reopened.slots).toEqual(final.slots);
  expect(reopened.grid.pinned).toBe(1);
  expect(positions(reopened)).toEqual(removed);
  expect(await screenPositions(page)).toEqual(removed);
  await expect(page.getByTestId('tile-published')).toHaveCount(3);
  await expect(page.getByTestId('tile-pinned')).toHaveCount(1);
  await expect(page.locator('[data-testid="tile"][data-state="empty"]')).toHaveCount(2);
  expect(await orders(page)).toEqual(['8', '7', '6', '5', '4', '3', '2', '1', null, null, null]);
  await expect(page.getByLabel('Закреплено')).toHaveValue('1');
});
