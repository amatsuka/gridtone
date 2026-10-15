// Хвосты интерфейса (docs/progress.md, «Хвосты интерфейса»): меню следует за интерфейсом — «Отменить» и «Повторить»
// по истории, отмеченный режим в «Виде», «Редактор фото» по выбранной плитке; «Показать в Finder» в итоге экспорта;
// выбросы на мини-карте яркости; плитки без данных названы в «Анализе», «Подгонке» и «Поправках к цели».
// Пункты меню Playwright не нажимает: состояние читается из main, а «клик» — MenuItem.click() в main, тот же
// обработчик, что у мыши. Логика состояния — в модульных тестах (tests/main/menu.test.ts, tests/renderer).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { analyzeGrid } from '../../src/core/metrics/grid';
import { tileMetrics } from '../../src/core/metrics/tile';
import { DEFAULT_LEVELS } from '../../src/core/pattern/levels';
import { withPatternTargets } from '../../src/core/pattern/pattern';
import { stringPattern } from '../../src/core/pattern/string';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Project } from '../../src/core/project/types';
import { VIEW_MODES, type ViewMode } from '../../shared/view';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e-tails-'));
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

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

/** Однотонные фото по порядку: имя начинается с номера, импорт ставит их по алфавиту путей. */
async function solidPhotos(dir: string, colors: readonly Rgb[]): Promise<string[]> {
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(dir, `${i + 1}`, W, H, () => color));
  return files;
}

async function createProject(dir: string, photos: string[]): Promise<{ page: Page; ids: string[] }> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: dir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${photos.length}`);
  return { page, ids: await expectTilesRendered(page, photos.length) };
}

interface MenuSnapshot {
  undo: boolean;
  redo: boolean;
  editor: boolean;
  /** Отмеченные пункты «Вида»: ровно один. */
  view: ViewMode[];
}

/** Пункты меню в main — то, что увидит пользователь, открыв меню. */
async function menuState(): Promise<MenuSnapshot> {
  return app!.evaluate(({ Menu }, modes) => {
    const item = (id: string) => Menu.getApplicationMenu()?.getMenuItemById(id);
    return {
      undo: item('undo')?.enabled ?? false,
      redo: item('redo')?.enabled ?? false,
      editor: item('editor')?.enabled ?? false,
      view: modes.filter((mode) => item(`view:${mode}`)?.checked),
    };
  }, [...VIEW_MODES]) as Promise<MenuSnapshot>;
}

async function expectMenu(expected: MenuSnapshot): Promise<void> {
  await expect.poll(menuState).toEqual(expected);
}

/** Клик по пункту меню — его обработчик в main, как у мыши: Electron сам отмечает radio до обработчика. */
async function clickMenu(id: string): Promise<void> {
  await app!.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`нет пункта ${id}`);
    item.click();
  }, id);
}

test('меню: «Отменить» и «Повторить», режим, «Редактор фото»; «Показать в Finder»; выбросы на карте яркости', async () => {
  // Шахматка из 4в: светлые места — 1, 3, 5, 7, 9; плитка 5 темнее остальных светлых — единственный выброс.
  const levels = [200, 70, 205, 66, 150, 74, 190, 62, 210];
  const projectDir = join(root, 'Меню');
  const { page, ids } = await createProject(projectDir, await solidPhotos(join(root, 'checker'), levels.map(gray)));
  const tiles = page.getByTestId('tile');

  // 1. После импорта истории нет (импорт в неё не входит), режим — «Рабочая сетка», плитка не выбрана.
  await expectMenu({ undo: false, redo: false, editor: false, view: ['grid'] });

  // 2. Выбросы на мини-карте яркости — те же плитки, что у analyzeGrid core по тем же прокси; точка в углу.
  const project = (await mainProject(page)) as Project;
  const byAsset = new Map<string, ReturnType<typeof tileMetrics>>();
  for (const id of ids) byAsset.set(id, tileMetrics(await readProxyImage(projectDir, id), createCrop(), '3:4', { photo: createAdjust() }));
  const core = analyzeGrid(project, Object.fromEntries(project.slots.map((slot) => [slot.id, byAsset.get(slot.assetId ?? '')])));
  expect(core.outliers.map((o) => o.index)).toEqual([4]);
  await page.getByRole('tab', { name: 'Анализ' }).click();
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-measured', '9');
  await expect(page.getByTestId('outliers-count')).toHaveAttribute('data-count', '1');
  const cells = page.getByTestId('luma-cell');
  const marked = await cells.evaluateAll((els) =>
    els.filter((el) => el.getAttribute('data-outlier') === 'true').map((el) => Number(el.getAttribute('data-index'))),
  );
  expect(marked).toEqual(core.outliers.map((o) => o.index));
  const outlierCell = cells.nth(4);
  await expect(outlierCell).toHaveAttribute('title', /выбивается: яркость/);
  await expect(cells.nth(0)).not.toHaveAttribute('title', /выбивается/);
  const dot = await outlierCell.evaluate((el) => {
    const window = globalThis as unknown as { getComputedStyle(element: unknown, pseudo: string): { backgroundColor: string; width: string } };
    const style = window.getComputedStyle(el, '::after');
    return { color: style.backgroundColor, width: style.width };
  });
  expect(dot).toEqual({ color: 'rgb(255, 107, 94)', width: '6px' });
  const plain = await cells.nth(0).evaluate((el) => {
    const window = globalThis as unknown as { getComputedStyle(element: unknown, pseudo: string): { content: string } };
    return window.getComputedStyle(el, '::after').content;
  });
  expect(plain).toBe('none');

  // 3. «Вид» отмечает режим: клавиша 3 — «Яркость»; пункт «Постеризация» переключает сетку и отметку.
  await page.keyboard.press('Digit3');
  await expect(page.getByTestId('view-mode')).toHaveAttribute('data-mode', 'luminance');
  await expectMenu({ undo: false, redo: false, editor: false, view: ['luminance'] });
  await clickMenu('view:posterize');
  await expect(page.getByTestId('view-mode')).toHaveAttribute('data-mode', 'posterize');
  await expectMenu({ undo: false, redo: false, editor: false, view: ['posterize'] });

  // Под диалогом экспорта renderer команду не выполняет: отметка, которую Electron поставил сам, возвращается.
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await clickMenu('view:grid');
  expect((await menuState()).view).toEqual(['posterize']);
  await expect(page.getByTestId('view-mode')).toHaveAttribute('data-mode', 'posterize');

  // 4. «Показать в Finder»: подпапка экспорта уходит в shell.showItemInFolder main; чужой путь main отвергает.
  await app!.evaluate(({ shell }) => {
    const calls: string[] = [];
    (globalThis as unknown as { revealed: string[] }).revealed = calls;
    shell.showItemInFolder = (path: string) => void calls.push(path);
  });
  const revealed = () => app!.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed);
  await dialog.getByTestId('calibration-section').getByRole('checkbox', { name: 'Калибровочная карта' }).check();
  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app!, { open: [exportRoot] });
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true');
  const exportDir = (await result.getAttribute('data-dir')) ?? '';
  expect(dirname(exportDir)).toBe(exportRoot);
  await result.getByRole('button', { name: 'Показать в Finder' }).click();
  await expect.poll(revealed).toEqual([exportDir]);
  const foreign = await page.evaluate(async (dir) => {
    const api = (globalThis as unknown as { gridtone: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }).gridtone;
    try {
      await api.invoke('export:reveal', dir);
      return 'показана';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, exportRoot);
  expect(foreign).toMatch(/не папка экспорта/);
  expect(await revealed()).toEqual([exportDir]);
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Digit2');
  await expectMenu({ undo: false, redo: false, editor: false, view: ['grid'] });

  // 5. «Редактор фото»: активен, когда выбрана плитка с фото и редактор закрыт; пункт открывает редактор.
  await tiles.nth(0).click();
  await expectMenu({ undo: false, redo: false, editor: true, view: ['grid'] });
  await clickMenu('editor');
  const editor = page.getByTestId('photo-editor');
  await expect(editor).toBeVisible();
  await expectMenu({ undo: false, redo: false, editor: false, view: ['grid'] });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expectMenu({ undo: false, redo: false, editor: true, view: ['grid'] });
  await page.keyboard.press('Escape');
  await expectMenu({ undo: false, redo: false, editor: false, view: ['grid'] });

  // 6. «Отменить» и «Повторить» — по истории: перестановка, ⌘Z, ⌘⇧Z.
  await tiles.nth(0).click();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await mainProject(page))?.slots[1]?.assetId).toBe(ids[0]);
  await expectMenu({ undo: true, redo: false, editor: true, view: ['grid'] });
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[0]?.assetId).toBe(ids[0]);
  await expectMenu({ undo: false, redo: true, editor: true, view: ['grid'] });
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expectMenu({ undo: true, redo: false, editor: true, view: ['grid'] });
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expectMenu({ undo: false, redo: true, editor: true, view: ['grid'] });

  // В текстовом поле оба активны и при пустой истории: ⌘Z там отменяет ввод через пункт меню (ADR 0011).
  await page.getByRole('tab', { name: 'Цель' }).click();
  const panel = page.getByTestId('target-panel');
  await panel.getByRole('button', { name: 'Строка', exact: true }).click();
  const field = panel.getByRole('textbox', { name: 'Строка-шаблон' });
  await field.focus();
  await expectMenu({ undo: true, redo: true, editor: true, view: ['grid'] });
  await field.blur();
  await expectMenu({ undo: false, redo: true, editor: true, view: ['grid'] });
});

const pattern = () => {
  const result = stringPattern('LDL/DLD', DEFAULT_LEVELS);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
};

test('плитки без данных: «Анализ», «Подгонка» и «Поправки к цели» называют их и не ждут', async () => {
  // Сетка 5г уже после подгонки под LDL/DLD: выбросы по цели — плитки 5, 6 и 8 (поправка, «заменить», поправка).
  // У плитки 1 пропали оригинал и превью, у плитки 3 превью испорчено: воркер метрик его не прочитает.
  const fitted = [189, 82, 192, 84, 165, 40, 186, 100, 195];
  const projectDir = join(root, 'Без данных');
  const { ids } = await createProject(projectDir, await solidPhotos(join(root, 'fitted'), fitted.map(gray)));
  await app!.close();
  app = undefined;
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  project.pattern = pattern();
  project.slots = withPatternTargets(project.slots, project.pattern, 0);
  await writeFile(file, JSON.stringify(project, null, 2));
  const lost = ids[0]!;
  await rm(project.assets[lost]!.path);
  await rm(join(projectDir, 'cache', 'proxies', lost), { recursive: true, force: true });
  await writeFile(join(projectDir, 'cache', 'proxies', ids[2]!, '512.jpg'), 'не JPEG');

  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expect(page.getByTestId('tile')).toHaveCount(9);

  // «Анализ»: признаки у 7 плиток, хода «посчитано N из M» нет, две плитки названы с причинами.
  await page.getByRole('tab', { name: 'Анализ' }).click();
  const analysis = page.getByTestId('analysis-panel');
  await expect(analysis).toHaveAttribute('data-measured', '7');
  const noData = page.getByTestId('analysis-no-data');
  await expect(noData).toHaveAttribute('data-count', '2');
  await expect(noData).toHaveText(
    'Нет данных для 2 плиток (позиции 1, 3): у позиции 1 превью не построено — оригинал пропал или изменился, ' +
      'у позиции 3 превью не читается. Анализ — по остальным плиткам.',
  );
  await expect(page.getByTestId('analysis-progress')).toHaveCount(0);
  await expect(page.getByTestId('rhythm')).toBeVisible();
  const cells = page.getByTestId('luma-cell');
  for (const index of [0, 2]) {
    await expect(cells.nth(index)).toHaveAttribute('data-no-data', 'true');
    await expect(cells.nth(index)).toHaveText('—');
  }
  await expect(cells.nth(1)).not.toHaveAttribute('data-no-data', 'true');

  // «Цель»: подгонка не ждёт — «нет данных»; поправки к цели названных плиток не проверены, остальные посчитаны.
  await page.getByRole('tab', { name: 'Цель' }).click();
  const fit = page.getByTestId('fit');
  await expect(fit).toHaveAttribute('data-state', 'unavailable');
  await expect(fit).toHaveAttribute('data-missing', '2');
  await expect(fit).toContainText('Нет данных для 2 плиток (позиции 1, 3)');
  await expect(fit).toContainText('верните оригинал на место и откройте проект заново');
  const fixesNote = page.getByTestId('target-fixes-no-data');
  await expect(fixesNote).toHaveAttribute('data-count', '2');
  await expect(fixesNote).toContainText('Нет данных для 2 плиток (позиции 1, 3)');
  await expect(fixesNote).toContainText('Попадание в цель у них не проверено.');
  const fixes = page.getByTestId('target-fixes');
  await expect(fixes).toHaveAttribute('data-state', 'list');
  const rows = fixes.getByTestId('outlier');
  await expect(rows).toHaveCount(3);
  expect((await rows.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-index'))))).sort()).toEqual([4, 5, 7]);
  const fixState = (index: number) =>
    fixes.locator('li.outlier-row', { has: page.locator(`[data-testid="outlier"][data-index="${index}"]`) }).getByTestId('outlier-fix');
  await expect(fixState(4)).toHaveAttribute('data-state', 'fix');
  await expect(fixState(5)).toHaveAttribute('data-state', 'replace');
  await expect(fixState(7)).toHaveAttribute('data-state', 'fix');
  const applyAll = page.getByTestId('apply-all-fixes');
  await expect(applyAll).toBeEnabled();
  await expect(applyAll).toHaveAttribute('data-count', '2');
});
