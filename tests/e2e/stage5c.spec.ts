// Критерий этапа 5в: картинка с квадратами открывается поверх окна с найденной сеткой 3 × N; сетку можно поправить
// вручную; цель ячейки — среднее её центральных 60%, жёсткая у заливки, мягкая у фото; «Применить» пишет паттерн
// source: 'image' и цели. docs/decisions/0024-pattern-image.md. Сетка и цели сверяются с core по тем же пикселям,
// что получил renderer: картинку читает та же функция индексатора (decodeSrgb), что и в приложении.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { linearSrgbToOklab } from '../../src/core/color/oklab';
import { decodeSrgb } from '../../src/core/color/transfer';
import type { RgbaImage } from '../../src/core/image/sample';
import { analyzeGrid, type GridAnalysis } from '../../src/core/metrics/grid';
import { tileMetrics, type TileMetrics } from '../../src/core/metrics/tile';
import { detectGrid, extractCells, gridFrame, imageLab, imagePattern, type ImageGrid } from '../../src/core/pattern/image';
import { DEFAULT_LEVELS, HARD_TOLERANCE, SOFT_TOLERANCE } from '../../src/core/pattern/levels';
import { targetAt } from '../../src/core/pattern/pattern';
import { stringPattern } from '../../src/core/pattern/string';
import type { Pattern, Project, SlotTarget } from '../../src/core/project/types';
import { mulberry32 } from '../../src/core/random';
import { decodePatternImage } from '../../src/indexer/patternImage';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, readProxyImage, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e5c-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Rgb8 = readonly [number, number, number];

/** Четыре оттенка шаблона: светлый и тёмный серый, тёплый и холодный цвет. */
const SHADES: Record<string, Rgb8> = { L: [205, 205, 205], D: [64, 64, 64], O: [224, 146, 84], B: [58, 92, 160] };
/** Ячейки по рядам: соседние по горизонтали и вертикали — разные, чтобы встык границы были видны. */
const LAYOUT = ['LDO', 'DBL', 'OLD', 'BDL'];
/** Ячейка шаблона-JPEG с «фото» вместо заливки: ряд 2, колонка 2. */
const PHOTO_CELL = 4;

interface Drawn {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  rows: number;
}

/** Около 1100 px шириной: квадраты 3:4, белые промежутки 16 px, поля 40 px. 1872 px высоты — индексатор уменьшит. */
const GAPPED: Drawn = { left: 40, top: 40, cellWidth: 327, cellHeight: 436, gap: 16, rows: 4 };
/** Встык, без полей и промежутков: 900 × 1600 — без уменьшения. */
const FLUSH: Drawn = { left: 0, top: 0, cellWidth: 300, cellHeight: 400, gap: 0, rows: 4 };

function drawnSize(t: Drawn): { width: number; height: number } {
  return { width: 2 * t.left + 3 * t.cellWidth + 2 * t.gap, height: 2 * t.top + t.rows * t.cellHeight + (t.rows - 1) * t.gap };
}

function shade(index: number): Rgb8 {
  return SHADES[LAYOUT[Math.floor(index / 3)]![index % 3]!]!;
}

/** Шаблон: точка принадлежит ячейке, если её центр внутри; photo — ячейка с шумным «фото» вместо заливки. */
async function writeTemplate(file: string, t: Drawn, format: 'png' | 'jpeg', photo?: number): Promise<string> {
  const { width, height } = drawnSize(t);
  const data = Buffer.alloc(width * height * 3, 255);
  const random = mulberry32(11);
  const noise = () => (random() * 2 - 1) * 35;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const column = Math.floor((x + 0.5 - t.left) / (t.cellWidth + t.gap));
      const row = Math.floor((y + 0.5 - t.top) / (t.cellHeight + t.gap));
      if (column < 0 || column > 2 || row < 0 || row >= t.rows) continue;
      const u = (x + 0.5 - t.left - column * (t.cellWidth + t.gap)) / t.cellWidth;
      const v = (y + 0.5 - t.top - row * (t.cellHeight + t.gap)) / t.cellHeight;
      if (u >= 1 || v >= 1) continue;
      const index = row * 3 + column;
      const base = 70 + 130 * u;
      const rgb: Rgb8 = index === photo ? [base + 40 + noise(), base + 10 + noise(), base - 20 + noise() + 30 * v] : shade(index);
      data.set(rgb.map((c) => Math.round(Math.min(255, Math.max(0, c)))), (y * width + x) * 3);
    }
  }
  const image = sharp(data, { raw: { width, height, channels: 3 } }).withIccProfile('srgb');
  await (format === 'png' ? image.png() : image.jpeg({ quality: 80 })).toFile(file);
  return file;
}

/** Нарисованная сетка в координатах прочитанной (уменьшенной) картинки. */
function scaled(t: Drawn, image: { width: number; height: number }): ImageGrid {
  const { width, height } = drawnSize(t);
  const sx = image.width / width;
  const sy = image.height / height;
  return {
    left: t.left * sx,
    top: t.top * sy,
    cellWidth: t.cellWidth * sx,
    cellHeight: t.cellHeight * sy,
    gapX: t.gap * sx,
    gapY: t.gap * sy,
    rows: t.rows,
  };
}

function expectGridClose(actual: ImageGrid, expected: ImageGrid, tolerance: number, label: string): void {
  expect(actual.rows, `${label}: рядов`).toBe(expected.rows);
  for (const key of ['left', 'top', 'cellWidth', 'cellHeight', 'gapX', 'gapY'] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${label}: ${key} ${actual[key]} вместо ${expected[key]}`).toBeLessThanOrEqual(tolerance);
  }
}

/** Сетка на экране — из data-атрибутов слоя, без округления. */
async function shownGrid(layer: Locator): Promise<ImageGrid> {
  const svg = layer.getByTestId('image-grid');
  const read = async (name: string) => Number(await svg.getAttribute(`data-${name}`));
  return {
    left: await read('left'),
    top: await read('top'),
    cellWidth: await read('cell-width'),
    cellHeight: await read('cell-height'),
    gapX: await read('gap-x'),
    gapY: await read('gap-y'),
    rows: await read('rows'),
  };
}

type ShownCell = { L: number; hue: number | null; chroma: number | null; hard: boolean };

async function shownCells(layer: Locator): Promise<ShownCell[]> {
  return layer.getByTestId('pattern-cell').evaluateAll((els) =>
    els.map((el) => {
      const num = (name: string) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
      return { L: Number(el.getAttribute('data-l')), hue: num('data-hue'), chroma: num('data-chroma'), hard: el.getAttribute('data-hard') === 'true' };
    }),
  );
}

/** Цели на экране — как у core: L, тон, хрома и жёсткость каждой ячейки. */
function expectCellsMatch(shown: ShownCell[], targets: SlotTarget[]): void {
  expect(shown).toHaveLength(targets.length);
  targets.forEach((target, i) => {
    const cell = shown[i]!;
    expect(cell.hard, `ячейка ${i + 1}: жёсткая`).toBe(target.hard);
    expect(Math.abs(cell.L - target.L), `ячейка ${i + 1}: L`).toBeLessThanOrEqual(1e-4);
    expect(cell.hue === null, `ячейка ${i + 1}: тон`).toBe(target.hue === undefined);
    if (target.hue !== undefined) expect(Math.abs(cell.hue! - target.hue), `ячейка ${i + 1}: тон`).toBeLessThanOrEqual(0.01);
    expect(cell.chroma === null, `ячейка ${i + 1}: хрома`).toBe(target.chroma === undefined);
    if (target.chroma !== undefined) expect(Math.abs(cell.chroma! - target.chroma), `ячейка ${i + 1}: хрома`).toBeLessThanOrEqual(1e-4);
  });
}

/** Паттерн в main — как у core: те же числа с точностью округления цели. */
function expectPatternClose(actual: Pattern | undefined, expected: Pattern): void {
  expect(actual).toBeDefined();
  expect({ ...actual!, cells: [] }).toEqual({ ...expected, cells: [] });
  expectCellsMatch(
    actual!.cells.map((c) => ({ L: c.L, hue: c.hue ?? null, chroma: c.chroma ?? null, hard: c.hard })),
    expected.cells,
  );
  actual!.cells.forEach((cell, i) => expect(cell.tolerance).toEqual(expected.cells[i]!.tolerance));
}

function lab8([r, g, b]: Rgb8): [number, number, number] {
  return linearSrgbToOklab(decodeSrgb([r / 255, g / 255, b / 255]));
}

/** Цели нарисованных заливок: L и, у цветных, тон — с точностью чтения и сжатия. */
function expectDrawnTargets(targets: SlotTarget[], tolerance: number, photo?: number): void {
  targets.forEach((target, i) => {
    if (i === photo) return;
    const [L, a, b] = lab8(shade(i));
    expect(Math.abs(target.L - L), `ячейка ${i + 1}: L`).toBeLessThanOrEqual(tolerance);
    const colored = Math.hypot(a, b) >= 0.03;
    expect(target.hue !== undefined, `ячейка ${i + 1}: тон есть только у цветной`).toBe(colored);
    if (colored) {
      const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      expect(Math.abs(target.hue! - hue), `ячейка ${i + 1}: тон`).toBeLessThanOrEqual(2);
    }
  });
}

// ─── Анализ: как в e2e 5б ────────────────────────────────────────────────────

const W = 900;
const H = 1200;
const RATIO_TOLERANCE = 0.15;
const gray = (v: number): Rgb => ({ r: v, g: v, b: v });
const COLORS = [192, 84, 150, 80, 186, 130, 195, 78, 188].map(gray);

async function coreAnalysis(page: Page, projectDir: string, images: Map<string, RgbaImage>): Promise<GridAnalysis> {
  const project = (await mainProject(page)) as Project;
  const bySlot: Record<string, TileMetrics> = {};
  for (const slot of project.slots) {
    if (!slot.assetId) continue;
    if (!images.has(slot.assetId)) images.set(slot.assetId, await readProxyImage(projectDir, slot.assetId));
    bySlot[slot.id] = tileMetrics(images.get(slot.assetId)!, slot.crop, project.grid.ratio, { photo: slot.adjust });
  }
  return analyzeGrid(project, bySlot);
}

async function expectDeviationMatchesCore(page: Page, expected: GridAnalysis): Promise<void> {
  const tiles = page.getByTestId('tile');
  for (const e of expected.expectations) {
    const fill = tiles.nth(e.index).getByTestId('tile-fill');
    await expect(fill, `плитка ${e.index + 1}`).toHaveAttribute('data-source', e.source);
    await expect
      .poll(async () => Math.abs(Number(await fill.getAttribute('data-value')) - e.deviation), { message: `плитка ${e.index + 1}` })
      .toBeLessThan(RATIO_TOLERANCE);
  }
}

test('паттерн из изображения: сетка 3 × N по пикселям, цели ячеек, ручная правка, «Применить» с отменой, не картинка', async () => {
  const templates = join(root, 'templates');
  await mkdir(templates, { recursive: true });
  const gapped = await writeTemplate(join(templates, 'шаблон.png'), GAPPED, 'png');
  const photo = await writeTemplate(join(templates, 'шаблон с фото.jpg'), GAPPED, 'jpeg', PHOTO_CELL);
  const flush = await writeTemplate(join(templates, 'встык.png'), FLUSH, 'png');
  const notImage = join(templates, 'не картинка.png');
  await writeFile(notImage, 'это не картинка');

  const files = [];
  for (const [i, color] of COLORS.entries()) files.push(await writePixelFixture(join(root, 'photos'), `${i + 1}`, W, H, () => color));
  const projectDir = join(root, 'Шаблон');
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 9');
  await expectTilesRendered(page, 9);

  // Прежний паттерн — строка LDL/DLD: ⌘Z после «Применить» должна вернуть его.
  await page.getByRole('tab', { name: 'Цель' }).click();
  const panel = page.getByTestId('target-panel');
  await panel.getByRole('button', { name: 'Строка', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Строка-шаблон' }).fill('LDL/DLD');
  await panel.getByRole('button', { name: 'Применить к сетке' }).click();
  const previous = stringPattern('LDL/DLD', DEFAULT_LEVELS);
  if (!previous.ok) throw new Error(previous.error);
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(previous.pattern);
  const before = (await mainProject(page))!;

  const fromImage = panel.getByRole('button', { name: 'Из изображения…' });
  const layer = page.getByTestId('pattern-import');

  // 1. PNG с промежутками и полями: сетка 3 × 4 — как у core по тем же пикселям и в пределах 2 px от нарисованной.
  await stubDialogs(app, { open: [gapped] });
  await fromImage.click();
  await expect(layer).toHaveAttribute('data-state', 'ready');
  const gappedImage = await decodePatternImage(gapped);
  // 1872 px высоты — уменьшено до 1600 по длинной стороне.
  expect([gappedImage.width, gappedImage.height]).toEqual([934, 1600]);
  await expect(layer).toHaveAttribute('data-image-width', '934');
  await expect(layer).toHaveAttribute('data-image-height', '1600');
  const gappedLab = imageLab(gappedImage);
  const gappedDetection = detectGrid(gappedLab, '3:4');
  expect(gappedDetection.found).toEqual({ columns: true, rows: true });
  const gappedGrid = await shownGrid(layer);
  expectGridClose(gappedGrid, gappedDetection.grid, 1e-6, 'как у core');
  expectGridClose(gappedGrid, scaled(GAPPED, gappedImage), 2, 'как нарисовано');
  await expect(layer.getByTestId('grid-status')).toHaveAttribute('data-found-columns', 'true');
  await expect(layer.getByTestId('grid-status')).toHaveAttribute('data-found-rows', 'true');
  await expect(layer.getByTestId('grid-status')).toContainText('Найдена сетка 3 × 4');

  // 2. Превью целей: L, тон, хрома и «жёсткая» каждой ячейки — как у core; у серых тона нет, все — заливки.
  const gappedCells = extractCells(gappedLab, gappedGrid).map((c) => c.target);
  expectCellsMatch(await shownCells(layer), gappedCells);
  expectDrawnTargets(gappedCells, 0.002);
  expect(gappedCells.every((t) => t.hard && JSON.stringify(t.tolerance) === JSON.stringify(HARD_TOLERANCE))).toBe(true);
  await expect(layer.getByTestId('pattern-preview')).toHaveAttribute('data-rows', '4');

  // Esc закрывает слой, проект не меняется.
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  expect(await mainProject(page)).toEqual(before);

  // 3. JPEG q80 той же картинки, в одной ячейке — шумное «фото»: сетка та же, цель «фото» мягкая, остальные жёсткие.
  await stubDialogs(app, { open: [photo] });
  await fromImage.click();
  await expect(layer).toHaveAttribute('data-state', 'ready');
  const photoImage = await decodePatternImage(photo);
  const photoLab = imageLab(photoImage);
  const photoGrid = await shownGrid(layer);
  expectGridClose(photoGrid, detectGrid(photoLab, '3:4').grid, 1e-6, 'JPEG как у core');
  expectGridClose(photoGrid, scaled(GAPPED, photoImage), 2, 'JPEG как нарисовано');
  const photoCells = extractCells(photoLab, photoGrid).map((c) => c.target);
  expectCellsMatch(await shownCells(layer), photoCells);
  expect(photoCells.map((t) => t.hard)).toEqual(Array.from({ length: 12 }, (_, i) => i !== PHOTO_CELL));
  expect(photoCells[PHOTO_CELL]!.tolerance).toEqual(SOFT_TOLERANCE);
  expect(photoCells.filter((_, i) => i !== PHOTO_CELL).every((t) => JSON.stringify(t.tolerance) === JSON.stringify(HARD_TOLERANCE))).toBe(true);
  expectDrawnTargets(photoCells, 0.01, PHOTO_CELL);
  await expect(layer.getByTestId('pattern-cell').nth(PHOTO_CELL)).toHaveAttribute('data-hard', 'false');
  await layer.getByRole('button', { name: 'Отмена' }).click();
  await expect(layer).toHaveCount(0);

  // 4. Встык, без промежутков и полей: сетка по границам цветов. Ручная правка — нижний край поднят на ряд, «Рядов: 3».
  await stubDialogs(app, { open: [flush] });
  await fromImage.click();
  await expect(layer).toHaveAttribute('data-state', 'ready');
  const flushImage = await decodePatternImage(flush);
  expect([flushImage.width, flushImage.height]).toEqual([900, 1600]);
  const flushLab = imageLab(flushImage);
  const flushDetection = detectGrid(flushLab, '3:4');
  expect(flushDetection.found).toEqual({ columns: true, rows: true });
  const flushGrid = await shownGrid(layer);
  expectGridClose(flushGrid, flushDetection.grid, 1e-6, 'встык как у core');
  expectGridClose(flushGrid, scaled(FLUSH, flushImage), 2, 'встык как нарисовано');

  const svg = layer.getByTestId('image-grid');
  const box = (await svg.boundingBox())!;
  const sy = box.height / flushImage.height;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height - 1);
  await page.mouse.down();
  await page.mouse.move(x, box.y + (flushImage.height - FLUSH.cellHeight) * sy, { steps: 10 });
  await page.mouse.up();
  const dragged = await shownGrid(layer);
  expect(dragged.rows).toBe(4);
  expect(Math.abs(gridFrame(dragged).bottom - (flushImage.height - FLUSH.cellHeight))).toBeLessThanOrEqual(3);
  await layer.getByRole('spinbutton', { name: 'Рядов' }).fill('3');
  const manual = await shownGrid(layer);
  expect(manual.rows).toBe(3);
  expect(gridFrame(manual).bottom).toBeCloseTo(gridFrame(dragged).bottom, 6);
  expect(Math.abs(manual.cellHeight - FLUSH.cellHeight)).toBeLessThanOrEqual(1.5);
  await expect(layer.getByTestId('grid-status')).toContainText('поправлена вручную');
  const manualCells = extractCells(flushLab, manual);
  expectCellsMatch(await shownCells(layer), manualCells.map((c) => c.target));
  expectDrawnTargets(
    manualCells.map((c) => c.target),
    0.002,
  );

  // 5. «Применить»: паттерн source: 'image', период — 3 ряда, цели позиций — по нему; режим 7 — от целей; ⌘Z — прежний.
  const expected = imagePattern(manualCells);
  await layer.getByRole('button', { name: 'Применить' }).click();
  await expect(layer).toHaveCount(0);
  await expect.poll(async () => (await mainProject(page))?.pattern?.source).toBe('image');
  const applied = (await mainProject(page))!;
  expectPatternClose(applied.pattern, expected);
  expect(applied.pattern?.periodRows).toBe(3);
  expect(applied.slots.map((slot) => slot.target)).toEqual(applied.slots.map((_, i) => targetAt(applied.pattern!, i, applied.grid.pinned)));
  await expect(panel.getByTestId('current-pattern')).toHaveAttribute('data-source', 'image');
  await page.keyboard.press('Digit7');
  const analysis = await coreAnalysis(page, projectDir, new Map());
  expect(analysis.expectations).toHaveLength(9);
  expect(analysis.expectations.every((e) => e.source === 'target')).toBe(true);
  await expectDeviationMatchesCore(page, analysis);
  await page.keyboard.press('Digit2');
  await page.getByTestId('tile').nth(4).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.pattern).toEqual(previous.pattern);
  expect((await mainProject(page))?.slots).toEqual(before.slots);

  // 6. Файл не картинка — ошибка во вкладке «Цель», слой не открывается, проект не меняется.
  await stubDialogs(app, { open: [notImage] });
  await fromImage.click();
  const error = panel.getByTestId('pattern-image-error');
  await expect(error).toContainText('не картинка.png');
  await expect(error).toContainText('не удалось прочитать изображение');
  await expect(layer).toHaveCount(0);
  expect(await mainProject(page)).toEqual(before);
});
