// Критерий этапа 5д: у каждой запланированной и пустой позиции есть карточка — номер в порядке публикации, образец
// цели и словесная подсказка; у паттерна «пачками» карточки сгруппированы по три; план экспортируется в `План.md`,
// `План.csv` и `Цели.png` в новую подпапку. docs/decisions/0026-content-plan.md. Карточки и файлы сверяются с core
// по проекту из main.
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { DEFAULT_GENERATOR, generatePattern, type GeneratorParams } from '../../src/core/pattern/generator';
import { DEFAULT_LEVELS } from '../../src/core/pattern/levels';
import { contentPlan, planCsv, planMarkdown, type ContentPlan } from '../../src/core/pattern/plan';
import { targetGridColors } from '../../src/core/pattern/targetGrid';
import { GRID_EMPTY, gridLayout } from '../../src/core/project/publish';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { launch, mainProject, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e5e-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const W = 600;
const H = 800;
/** Образец на экране и пиксели `Цели.png` против core: ±1 из 255. */
const RGB_TOLERANCE = 1;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });
/** Все разные: одинаковые фото импорт считает одним. Имя второго — с кавычками и запятой: CSV берёт его в кавычки. */
const PHOTOS: [string, Rgb][] = [
  ['кадр 1', gray(200)],
  ['кадр "2", утро', gray(90)],
  ['кадр 3', gray(180)],
  ['кадр 4', gray(70)],
  ['кадр 5', gray(160)],
  ['кадр 6', gray(60)],
];

const generated = (params: Partial<GeneratorParams>) => generatePattern({ ...DEFAULT_GENERATOR, ...params }, DEFAULT_LEVELS);

/** Ждёт, пока холст нарисует фото во всех плитках с фото. */
async function expectPhotosRendered(page: Page, count: number): Promise<void> {
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(count);
  for (const tile of await tiles.all()) {
    if ((await tile.getAttribute('data-asset-id')) === null) continue;
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toHaveAttribute('data-rendered', 'true');
  }
}

interface ShownCard {
  number: number;
  index: number;
  batch: number | null;
  pin: boolean;
  photo: boolean;
  hint: string;
  text: string;
  rgb: number[] | null;
}

/** Карточки плана на экране в их порядке: атрибуты, текст номера и цвет образца после CSS. */
function shownCards(page: Page): Promise<ShownCard[]> {
  return page.getByTestId('plan-card').evaluateAll((els) => {
    const window = globalThis as unknown as { getComputedStyle(element: unknown): { backgroundColor: string } };
    return els.map((el) => {
      const swatch = el.querySelector('[data-testid="plan-swatch"]');
      const css = swatch && !swatch.classList.contains('none') ? window.getComputedStyle(swatch).backgroundColor : null;
      return {
        number: Number(el.getAttribute('data-number')),
        index: Number(el.getAttribute('data-index')),
        batch: el.hasAttribute('data-batch') ? Number(el.getAttribute('data-batch')) : null,
        pin: el.getAttribute('data-pin') === 'true',
        photo: el.getAttribute('data-photo') === 'true',
        hint: el.querySelector('[data-testid="plan-hint"]')?.textContent ?? '',
        text: el.querySelector('[data-testid="plan-number"]')?.textContent ?? '',
        rgb: css ? (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) : null,
      };
    });
  });
}

/** Карточки на экране — как contentPlan core: номера, позиции, пачки, закрепление, подсказка, образец ±1. */
async function expectCardsMatchCore(page: Page, plan: ContentPlan): Promise<ShownCard[]> {
  await expect(page.getByTestId('plan-card')).toHaveCount(plan.cards.length);
  const shown = await shownCards(page);
  expect(shown.map((c) => [c.number, c.index, c.batch, c.pin, c.photo, c.hint])).toEqual(
    plan.cards.map((c) => [c.number, c.index, c.batch, c.pin, c.photo !== null, c.hint]),
  );
  plan.cards.forEach((card, i) => {
    const rgb = shown[i]!.rgb;
    if (!card.rgb) {
      expect(rgb, `карточка ${card.number}: образца нет`).toBeNull();
      return;
    }
    expect(rgb, `карточка ${card.number}: образец`).not.toBeNull();
    card.rgb.forEach((v, c) => expect(Math.abs(rgb![c]! - v), `карточка ${card.number}, канал ${c}`).toBeLessThanOrEqual(RGB_TOLERANCE));
  });
  expect(await page.getByTestId('plan-warning').allTextContents()).toEqual(plan.warnings);
  return shown;
}

/** Нажимает «Экспортировать…» и ждёт итога. Возвращает новую подпапку. */
async function runExport(dialog: Locator): Promise<string> {
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true', { timeout: 120_000 });
  return (await result.getAttribute('data-dir')) ?? '';
}

/** Файлы подпапки с содержимым: по ним видно, что повторный экспорт её не тронул. */
async function folderBytes(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) files[name] = (await readFile(join(dir, name))).toString('base64');
  return files;
}

test('план контента: карточки в порядке публикации, пачки, закреплённые, экспорт плана и подгонка без данных', async () => {
  const files = [];
  for (const [name, color] of PHOTOS) files.push(await writePixelFixture(join(root, 'photos'), name, W, H, () => color));
  const projectDir = join(root, 'Лента 5д');
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 6');
  await expectPhotosRendered(page, 6);
  const tiles = page.getByTestId('tile');

  // 1. Нижний ряд опубликован, в начале — ряд пустых, паттерн «Чередование двух цветов».
  await tiles.nth(3).click();
  await tiles.nth(5).click({ modifiers: ['Shift'] });
  await page.getByRole('checkbox', { name: 'Опубликован' }).check();
  await expect.poll(async () => (await mainProject(page))?.slots.map((slot) => slot.state)).toEqual([
    'planned',
    'planned',
    'planned',
    'published',
    'published',
    'published',
  ]);
  await page.getByRole('button', { name: '+ Ряд пустых' }).click();
  await expect.poll(async () => (await mainProject(page))?.slots.length).toBe(9);
  await page.getByRole('tab', { name: 'Цель' }).click();
  const panel = page.getByTestId('target-panel');
  await panel.getByLabel('Шаблон').selectOption('twoColors');
  await panel.getByRole('button', { name: 'Применить к сетке' }).click();
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(generated({ template: 'twoColors' }));

  // «План контента» — 6 карточек, номера 1–6 снизу вверх, образец и подсказка — как у core.
  const section = panel.getByTestId('content-plan');
  await expect(section).toHaveAttribute('data-count', '6');
  let project = (await mainProject(page))!;
  let plan = contentPlan(project);
  expect(plan.cards.map((c) => [c.number, c.index, c.photo === null])).toEqual([
    [1, 5, false],
    [2, 4, false],
    [3, 3, false],
    [4, 2, true],
    [5, 1, true],
    [6, 0, true],
  ]);
  const shown = await expectCardsMatchCore(page, plan);
  expect(new Set(shown.map((c) => c.hint))).toEqual(
    new Set(['средний, тёплый, умеренно насыщенный', 'средний, холодный, умеренно насыщенный']),
  );
  expect(shown.map((c) => c.text)).toEqual(plan.cards.map((c) => `${c.number}-й · позиция ${c.index + 1}`));
  // Без пачек — одна группа без заголовка.
  await expect(panel.getByTestId('plan-group-title')).toHaveCount(0);
  // Клик по карточке выделяет позицию.
  await panel.getByTestId('plan-card').nth(1).click();
  await expect(page.locator('[data-testid="tile"][aria-selected="true"]')).toHaveCount(1);
  await expect(tiles.nth(4)).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('plan-card').nth(1)).toHaveAttribute('aria-pressed', 'true');

  // 2. «Полосы по строкам» — пачками: «Пачка 1» и «Пачка 2» по три карточки.
  await panel.getByLabel('Шаблон').selectOption('rows');
  await panel.getByLabel('Уровней').selectOption('2');
  await panel.getByRole('button', { name: 'Применить к сетке' }).click();
  await expect.poll(async () => (await mainProject(page))?.pattern?.postingMode).toBe('batch');
  await expect(section).toHaveAttribute('data-posting-mode', 'batch');
  project = (await mainProject(page))!;
  plan = contentPlan(project);
  await expect(panel.getByTestId('plan-group-title')).toHaveText(['Пачка 1', 'Пачка 2']);
  const groups = panel.getByTestId('plan-group');
  await expect(groups.nth(0).getByTestId('plan-card')).toHaveCount(3);
  await expect(groups.nth(1).getByTestId('plan-card')).toHaveCount(3);
  expect(plan.cards.map((c) => c.batch)).toEqual([1, 1, 1, 2, 2, 2]);
  await expectCardsMatchCore(page, plan);
  await expect(panel.getByTestId('plan-warning')).toHaveCount(0);

  // Две пустые удалены — в плане 4 позиции: неполная пачка, предупреждение о неполном ряде.
  await tiles.nth(1).click();
  await tiles.nth(2).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await mainProject(page))?.slots.length).toBe(7);
  await expect(section).toHaveAttribute('data-count', '4');
  project = (await mainProject(page))!;
  plan = contentPlan(project);
  expect(plan.cards.map((c) => c.batch)).toEqual([1, 1, 1, 2]);
  expect(plan.warnings).toEqual(['Позиций ленты в плане — 4, не кратно трём: последняя пачка неполная, лента сдвинется на неполный ряд.']);
  await expect(panel.getByTestId('plan-group-title')).toHaveText(['Пачка 1', 'Пачка 2']);
  await expectCardsMatchCore(page, plan);

  // 3. «Закреплено: 1» — карточка закреплённой позиции последняя, с «закрепить»; лента — ровно пачка.
  await page.getByLabel('Закреплено').selectOption('1');
  await expect.poll(async () => (await mainProject(page))?.grid.pinned).toBe(1);
  project = (await mainProject(page))!;
  plan = contentPlan(project);
  expect(plan.cards.map((c) => [c.number, c.index, c.pin, c.batch])).toEqual([
    [1, 3, false, 1],
    [2, 2, false, 1],
    [3, 1, false, 1],
    [4, 0, true, null],
  ]);
  await expect(panel.getByTestId('plan-group-title')).toHaveText(['Пачка 1', 'Закрепить']);
  const cards = await expectCardsMatchCore(page, plan);
  expect(cards.at(-1)?.text).toBe('4-й · закрепить · позиция 1');
  expect(cards.at(-1)?.hint).toBe('цели нет');

  // 4. «Экспорт» → «План», все три формата: тексты — байт в байт как core, Цели.png — цвета целей ±1.
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const planSection = dialog.getByTestId('plan-section');
  for (const name of ['План.md', 'План.csv', 'Цели.png']) await planSection.getByRole('checkbox', { name }).check();
  await expect(planSection.getByTestId('plan-count')).toContainText('4 позиции плана');
  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  const first = await runExport(dialog);
  await expect(dialog.getByTestId('export-error')).toHaveCount(0);
  expect((await readdir(first)).sort()).toEqual(['План.csv', 'План.md', 'Цели.png']);
  project = (await mainProject(page))!;
  plan = contentPlan(project);
  const md = await readFile(join(first, 'План.md'));
  expect(md.equals(Buffer.from(planMarkdown(plan, project.name), 'utf8'))).toBe(true);
  expect(md.toString('utf8')).toContain('# План контента — Лента 5д');
  const csv = await readFile(join(first, 'План.csv'));
  expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(csv.equals(Buffer.from(planCsv(plan), 'utf8'))).toBe(true);
  const csvText = csv.toString('utf8');
  expect(csvText).toContain('\r\n');
  expect(csvText).toContain('"кадр ""2"", утро.jpg"');
  expect(csvText).toContain(',"светлый, цвет любой",');
  const png = join(first, 'Цели.png');
  const layout = gridLayout(project.slots.length, project.grid.ratio, project.grid.columns);
  const meta = await sharp(png).metadata();
  expect([meta.width, meta.height, meta.hasProfile]).toEqual([layout.width, layout.height, true]);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = targetGridColors(project);
  expect(colors[0]).toBeNull();
  expect(colors.slice(1).every((color) => color !== null)).toBe(true);
  colors.forEach((color, i) => {
    const expected = color ?? [...GRID_EMPTY];
    const [x0, y0] = layout.cells[i]!;
    for (const [dx, dy] of [
      [1, 1],
      [layout.tileWidth / 2, layout.tileHeight / 2],
      [layout.tileWidth - 2, layout.tileHeight - 2],
    ] as const) {
      const at = ((y0 + dy) * info.width + (x0 + dx)) * info.channels;
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(data[at + c]! - expected[c]!), `плитка ${i + 1}, канал ${c}`).toBeLessThanOrEqual(RGB_TOLERANCE);
      }
    }
  });

  // Повторный экспорт — новая подпапка, первая не тронута.
  const before = await folderBytes(first);
  await stubDialogs(app, { open: [exportRoot] });
  const second = await runExport(dialog);
  expect(second).not.toBe(first);
  expect((await readdir(second)).sort()).toEqual(['План.csv', 'План.md', 'Цели.png']);
  expect(await folderBytes(first)).toEqual(before);
  await dialog.getByRole('button', { name: 'Закрыть' }).click();

  // 5. Оригинал и превью плитки пропали: подгонка не ждёт вечно — «нет данных для 1 плитки»; план — на месте.
  const lost = project.slots[1]!.assetId!;
  const lostPath = project.assets[lost]!.path;
  await app.close();
  app = undefined;
  await rm(lostPath);
  await rm(join(projectDir, 'cache', 'proxies', lost), { recursive: true, force: true });
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expect(page.getByTestId('tile')).toHaveCount(7);
  await page.getByRole('tab', { name: 'Цель' }).click();
  const fit = page.getByTestId('fit');
  await expect(fit).toHaveAttribute('data-state', 'unavailable');
  await expect(fit).toHaveAttribute('data-missing', '1');
  await expect(fit).toContainText('Нет данных для 1 плитки (позиция 2)');
  await expect(page.getByTestId('content-plan')).toHaveAttribute('data-count', '4');
  await expectCardsMatchCore(page, contentPlan((await mainProject(page))!));
});
