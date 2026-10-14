import { describe, expect, test } from 'vitest';
import { linearSrgbToOklab } from '@core/color/oklab';
import { decodeSrgb } from '@core/color/transfer';
import type { RgbaImage } from '@core/image/sample';
import { NEUTRAL_CHROMA } from '@core/metrics/features';
import {
  CELL_SAMPLE_FRACTION,
  detectGrid,
  dragGridLine,
  extractCells,
  fallbackGrid,
  gradientProfiles,
  gridFrame,
  gridLines,
  HARD_SPREAD,
  imageLab,
  imagePattern,
  MIN_GRID_CELL,
  sampleRect,
  setGridRows,
  type ImageGrid,
} from '@core/pattern/image';
import { HARD_TOLERANCE, SOFT_TOLERANCE } from '@core/pattern/levels';
import { postingModeOf } from '@core/pattern/pattern';
import { mulberry32 } from '@core/random';

type Rgb8 = readonly [number, number, number];

const WHITE: Rgb8 = [255, 255, 255];
/** Четыре оттенка: светлый и тёмный серый, тёплый и холодный цвет. */
const SHADES: Rgb8[] = [
  [214, 214, 214],
  [70, 70, 70],
  [222, 150, 92],
  [62, 92, 152],
];

interface Drawing {
  width: number;
  height: number;
  grid: ImageGrid;
  /** Цвет ячейки; по умолчанию — оттенки по кругу, соседние разные. */
  color?: (row: number, column: number) => Rgb8;
  /** Свой цвет точки ячейки: u, v — 0..1 внутри ячейки. */
  pixel?: (row: number, column: number, u: number, v: number) => Rgb8;
  background?: Rgb8;
}

const defaultColor = (row: number, column: number): Rgb8 => SHADES[(row * 2 + column) % SHADES.length] as Rgb8;

/** Картинка-шаблон: точка принадлежит ячейке, если её центр внутри ячейки. */
function draw({ width, height, grid, color = defaultColor, pixel, background = WHITE }: Drawing): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgb = background;
      const cell = cellAt(grid, x + 0.5, y + 0.5);
      if (cell) {
        rgb = pixel ? pixel(cell.row, cell.column, cell.u, cell.v) : color(cell.row, cell.column);
      }
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function cellAt(grid: ImageGrid, px: number, py: number): { row: number; column: number; u: number; v: number } | null {
  const column = Math.floor((px - grid.left) / (grid.cellWidth + grid.gapX));
  const row = Math.floor((py - grid.top) / (grid.cellHeight + grid.gapY));
  if (column < 0 || column > 2 || row < 0 || row >= grid.rows) return null;
  const u = (px - grid.left - column * (grid.cellWidth + grid.gapX)) / grid.cellWidth;
  const v = (py - grid.top - row * (grid.cellHeight + grid.gapY)) / grid.cellHeight;
  if (u >= 1 || v >= 1) return null;
  return { row, column, u, v };
}

/** Шум и смаз, как у JPEG и уменьшения: ±amplitude по каналам и сглаживание 3 × 3. */
function degrade(image: RgbaImage, amplitude: number, seed = 1): RgbaImage {
  const { width, height } = image;
  const src = image.data;
  const out = new Uint8ClampedArray(src.length);
  const random = mulberry32(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            const yy = Math.min(height - 1, Math.max(0, y + dy));
            const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            sum += (src[(yy * width + xx) * 4 + c] as number) * w;
            weight += w;
          }
        }
        out[(y * width + x) * 4 + c] = Math.round(sum / weight + (random() * 2 - 1) * amplitude);
      }
      out[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function lab8([r, g, b]: Rgb8): [number, number, number] {
  return linearSrgbToOklab(decodeSrgb([r / 255, g / 255, b / 255]));
}

function deltaE(a: Rgb8, b: Rgb8): number {
  const [l1, a1, b1] = lab8(a);
  const [l2, a2, b2] = lab8(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function expectGridNear(actual: ImageGrid, expected: ImageGrid, tolerance: number): void {
  expect(actual.rows).toBe(expected.rows);
  for (const key of ['left', 'top', 'cellWidth', 'cellHeight', 'gapX', 'gapY'] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${key}: ${actual[key]} вместо ${expected[key]}`).toBeLessThanOrEqual(tolerance);
  }
}

/** Шаблон: поля, ячейки и промежутки; размеры картинки — по ним, плюс нижнее поле. */
function template(grid: ImageGrid, bottom = grid.top, right = grid.left): { width: number; height: number; grid: ImageGrid } {
  const frame = gridFrame(grid);
  return { width: Math.round(frame.right + right), height: Math.round(frame.bottom + bottom), grid };
}

describe('OKLab картинки', () => {
  test('каждая точка — OKLab её sRGB 8 бит, как у метрик плиток; RGB без альфы тоже', () => {
    const random = mulberry32(7);
    const rgba = new Uint8ClampedArray(16 * 4);
    const rgb = new Uint8Array(16 * 3);
    for (let i = 0; i < 16; i++) {
      for (let c = 0; c < 3; c++) {
        const v = Math.floor(random() * 256);
        rgba[i * 4 + c] = v;
        rgb[i * 3 + c] = v;
      }
      rgba[i * 4 + 3] = 255;
    }
    // Две одинаковые точки подряд: значение берётся из предыдущей и не отличается.
    rgba.copyWithin(4, 0, 4);
    rgb.copyWithin(3, 0, 3);
    const a = imageLab({ width: 4, height: 4, data: rgba });
    const b = imageLab({ width: 4, height: 4, data: rgb, channels: 3 });
    for (let i = 0; i < 16; i++) {
      const expected = lab8([rgba[i * 4] as number, rgba[i * 4 + 1] as number, rgba[i * 4 + 2] as number]);
      for (let c = 0; c < 3; c++) {
        expect(a.data[i * 3 + c]).toBe(Math.fround(expected[c] as number));
        expect(b.data[i * 3 + c]).toBe(a.data[i * 3 + c]);
      }
    }
  });
});

describe('профили градиента', () => {
  test('однотонная картинка — нули; длина — число границ точек, включая края картинки', () => {
    const { columns, rows } = gradientProfiles(imageLab(draw({ width: 20, height: 12, grid: emptyGrid(), background: [90, 120, 60] })));
    expect(columns).toHaveLength(21);
    expect(rows).toHaveLength(13);
    expect([...columns, ...rows].every((v) => v === 0)).toBe(true);
  });

  test('вертикальная граница — пик в профиле колонок на её месте: средний ΔE OKLab по строкам', () => {
    const a: Rgb8 = [200, 200, 200];
    const b: Rgb8 = [60, 60, 60];
    const width = 20;
    const height = 12;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Граница между точками 9 и 10, только в верхних 9 строках из 12.
        const rgb = x >= 10 && y < 9 ? b : a;
        data.set([...rgb, 255], (y * width + x) * 4);
      }
    }
    const { columns, rows } = gradientProfiles(imageLab({ width, height, data }));
    expect(columns[10]).toBeCloseTo((deltaE(a, b) * 9) / 12, 6);
    expect([...columns].filter((v, x) => x !== 10 && v !== 0)).toEqual([]);
    // Горизонтальная граница — под строкой 8, в правой половине: доля колонок 10 / 20.
    expect(rows[9]).toBeCloseTo((deltaE(a, b) * 10) / 20, 6);
    expect([...rows].filter((v, y) => y !== 9 && v !== 0)).toEqual([]);
  });

  test('градиент — по L, a и b: граница двух цветов одной яркости тоже видна', () => {
    const warm = [214, 150, 120] as const;
    const cool = [120, 170, 205] as const;
    const [lw] = lab8(warm);
    const [lc] = lab8(cool);
    expect(Math.abs(lw - lc)).toBeLessThan(0.02);
    const image = draw({ width: 30, height: 10, grid: { left: 0, top: 0, cellWidth: 10, cellHeight: 10, gapX: 0, gapY: 0, rows: 1 }, color: (_, c) => (c === 1 ? cool : warm) });
    const { columns } = gradientProfiles(imageLab(image));
    expect(columns[10]).toBeCloseTo(deltaE(warm, cool), 6);
    expect(columns[10]).toBeGreaterThan(0.1);
  });
});

function emptyGrid(): ImageGrid {
  return { left: 0, top: 0, cellWidth: 0, cellHeight: 0, gapX: 0, gapY: 0, rows: 0 };
}

describe('подбор регулярной сетки', () => {
  const cases: { name: string; grid: ImageGrid; bottom?: number; right?: number }[] = [
    { name: 'промежутки 16, поля 40, ячейки 3:4, 4 ряда', grid: { left: 40, top: 40, cellWidth: 327, cellHeight: 436, gapX: 16, gapY: 16, rows: 4 } },
    { name: 'встык, без полей, 1:1, 3 ряда', grid: { left: 0, top: 0, cellWidth: 300, cellHeight: 300, gapX: 0, gapY: 0, rows: 3 } },
    { name: 'промежутки без полей, 3:4, 2 ряда', grid: { left: 0, top: 0, cellWidth: 240, cellHeight: 320, gapX: 10, gapY: 10, rows: 2 } },
    { name: 'поля без промежутков, 1:1, 5 рядов', grid: { left: 30, top: 30, cellWidth: 200, cellHeight: 200, gapX: 0, gapY: 0, rows: 5 } },
    {
      name: 'разные поля: подпись сверху, узкие бока, широкий низ; разные промежутки',
      grid: { left: 24, top: 160, cellWidth: 280, cellHeight: 373, gapX: 6, gapY: 12, rows: 3 },
      bottom: 220,
      right: 30,
    },
    { name: 'один ряд', grid: { left: 20, top: 20, cellWidth: 250, cellHeight: 333, gapX: 8, gapY: 8, rows: 1 } },
    { name: 'дробные размеры ячеек', grid: { left: 36.5, top: 41, cellWidth: 329.33, cellHeight: 439.1, gapX: 15.5, gapY: 15.5, rows: 3 } },
  ];

  for (const { name, grid, bottom, right } of cases) {
    test(`${name}: сетка находится с точностью до 0.6 px`, () => {
      const spec = template(grid, bottom, right);
      const detection = detectGrid(imageLab(draw(spec)), '3:4');
      expect(detection.found).toEqual({ columns: true, rows: true });
      // Края нарисованы по центрам точек: дробный край сдвигается до половины точки.
      expectGridNear(detection.grid, grid, 0.6);
    });
  }

  test('шум и смаз, как у JPEG: сетка та же с точностью до 1 px', () => {
    for (const grid of [cases[0]!.grid, cases[1]!.grid, cases[4]!.grid]) {
      const spec = template(grid);
      const detection = detectGrid(imageLab(degrade(draw(spec), 6)), '3:4');
      expect(detection.found).toEqual({ columns: true, rows: true });
      expectGridNear(detection.grid, grid, 1);
    }
  });

  test('N — по высоте: от 1 до 8 рядов, широкое нижнее поле — не ряд', () => {
    for (const rows of [1, 2, 4, 6, 8]) {
      const grid: ImageGrid = { left: 20, top: 20, cellWidth: 150, cellHeight: 200, gapX: 8, gapY: 8, rows };
      const detection = detectGrid(imageLab(draw(template(grid, 260))), '3:4');
      expect(detection.grid.rows, `${rows} рядов`).toBe(rows);
      expectGridNear(detection.grid, grid, 0.5);
    }
  });

  test('встык: соседние ячейки одной яркости, но разного цвета — граница по цвету', () => {
    const warm: Rgb8 = [214, 150, 120];
    const cool: Rgb8 = [120, 170, 205];
    const grid: ImageGrid = { left: 0, top: 0, cellWidth: 200, cellHeight: 266, gapX: 0, gapY: 0, rows: 4 };
    const detection = detectGrid(imageLab(draw({ ...template(grid), color: (r, c) => ((r + c) % 2 === 0 ? warm : cool) })), '3:4');
    expect(detection.found).toEqual({ columns: true, rows: true });
    expectGridNear(detection.grid, grid, 0.5);
  });

  test('шумное «фото» в ячейке не сбивает сетку', () => {
    const grid = cases[0]!.grid;
    const random = mulberry32(3);
    const pixel = (row: number, column: number, u: number, v: number): Rgb8 => {
      if (row !== 1 || column !== 1) return defaultColor(row, column);
      const base = 60 + 150 * u * v;
      const n = () => Math.round((random() * 2 - 1) * 45);
      return [base + n(), base * 0.8 + n(), base * 0.6 + 40 + n()];
    };
    const detection = detectGrid(imageLab(draw({ ...template(grid), pixel })), '3:4');
    expect(detection.found).toEqual({ columns: true, rows: true });
    expectGridNear(detection.grid, grid, 0.5);
  });

  test('если подобрать не удалось — вся картинка 3 × N по пропорциям сетки', () => {
    const blank = imageLab(draw({ width: 900, height: 1600, grid: emptyGrid(), background: [128, 128, 128] }));
    const detection = detectGrid(blank, '3:4');
    expect(detection.found).toEqual({ columns: false, rows: false });
    // 3:4 — ячейка 300 × 400, четыре ряда ровно по высоте.
    expect(detection.grid).toEqual({ left: 0, top: 0, cellWidth: 300, cellHeight: 400, gapX: 0, gapY: 0, rows: 4 });
    expect(fallbackGrid(900, 1600, '3:4')).toEqual(detection.grid);
    // 1:1 — пять рядов: 1600 / 300 ≈ 5.3, ячейки растянуты на всю высоту.
    expect(fallbackGrid(900, 1600, '1:1')).toEqual({ left: 0, top: 0, cellWidth: 300, cellHeight: 320, gapX: 0, gapY: 0, rows: 5 });
    // Не больше 30 рядов и не меньше одного.
    expect(fallbackGrid(30, 2000, '1:1').rows).toBe(30);
    expect(fallbackGrid(900, 100, '3:4')).toMatchObject({ rows: 1, cellHeight: 100 });
  });

  test('полосы по строкам встык: колонки не найдены — по ширине поровну, ряды найдены', () => {
    const grid: ImageGrid = { left: 0, top: 0, cellWidth: 300, cellHeight: 400, gapX: 0, gapY: 0, rows: 3 };
    const detection = detectGrid(imageLab(draw({ ...template(grid), color: (r) => (r % 2 === 0 ? SHADES[0]! : SHADES[1]!) })), '3:4');
    expect(detection.found).toEqual({ columns: false, rows: true });
    expectGridNear(detection.grid, grid, 0.5);
  });
});

describe('цели ячеек', () => {
  const grid: ImageGrid = { left: 10, top: 10, cellWidth: 60, cellHeight: 80, gapX: 4, gapY: 4, rows: 2 };
  const size = template(grid, 10, 10);

  test('центральные 60%: точки с центрами внутри, по каждой стороне', () => {
    expect(CELL_SAMPLE_FRACTION).toBe(0.6);
    // Ячейка 60 × 80 с левого верхнего угла (10, 10): поле 36 × 48 от (22, 26).
    expect(sampleRect({ x: 10, y: 10, w: 60, h: 80 }, 100, 200)).toEqual({ x0: 22, y0: 26, x1: 58, y1: 74 });
    // Дробные края: точка 2 (центр 2.5) — внутри [2.3, 8.3), точка 8 (центр 8.5) — нет.
    expect(sampleRect({ x: 0.3, y: 0, w: 10, h: 10 }, 100, 200)).toMatchObject({ x0: 2, x1: 8 });
    // Совсем маленькая ячейка — хотя бы одна точка в центре; поле не выходит за картинку.
    expect(sampleRect({ x: 5, y: 5, w: 0.5, h: 0.5 }, 100, 200)).toEqual({ x0: 5, y0: 5, x1: 6, y1: 6 });
    expect(sampleRect({ x: 90, y: 190, w: 40, h: 40 }, 100, 200)).toEqual({ x0: 98, y0: 198, x1: 100, y1: 200 });
  });

  test('рамка за пределами центральных 60% не влияет на цель, внутри — влияет', () => {
    const ring = (width: number) => (_r: number, _c: number, u: number, v: number): Rgb8 =>
      Math.min(u, v, 1 - u, 1 - v) < width ? [255, 0, 0] : SHADES[3]!;
    const clean = extractCells(imageLab(draw({ ...size, pixel: ring(0.19) })), grid);
    const [L, a, b] = lab8(SHADES[3]!);
    for (const cell of clean) {
      expect(cell.mean[0]).toBeCloseTo(L, 6);
      expect(cell.mean[1]).toBeCloseTo(a, 6);
      expect(cell.mean[2]).toBeCloseTo(b, 6);
      expect(cell.target.hard).toBe(true);
    }
    const dirty = extractCells(imageLab(draw({ ...size, pixel: ring(0.25) })), grid);
    expect(dirty[0]!.mean[1]).toBeGreaterThan(a + 0.01);
  });

  test('цель — среднее OKLab точек, а не OKLab среднего цвета', () => {
    const half = (_r: number, _c: number, u: number): Rgb8 => (u < 0.5 ? [0, 0, 0] : [255, 255, 255]);
    const [cell] = extractCells(imageLab(draw({ ...size, pixel: half })), grid);
    expect(cell!.mean[0]).toBeCloseTo(0.5, 6);
    expect(cell!.spread[0]).toBeCloseTo(0.5, 6);
    expect(cell!.target.L).toBe(0.5);
    // Разброс огромный — мягкая цель.
    expect(cell!.target.hard).toBe(false);
  });

  test('жёсткая цель — у заливки, мягкая — у фото; допуски — по ней', () => {
    expect(HARD_SPREAD).toEqual({ L: 0.03, ab: 0.02 });
    const random = mulberry32(5);
    const pixel = (row: number, column: number, u: number): Rgb8 => {
      if (row === 0 && column === 1) {
        const v = 70 + 140 * u;
        return [v, v, v];
      }
      // Заливка с шумом ±3 из 255 — всё ещё заливка.
      const base = SHADES[(row + column) % 2]!;
      const n = () => Math.round((random() * 2 - 1) * 3);
      return [base[0] + n(), base[1] + n(), base[2] + n()];
    };
    const cells = extractCells(imageLab(draw({ ...size, pixel })), grid);
    expect(cells.map((c) => c.target.hard)).toEqual([true, false, true, true, true, true]);
    const photo = cells[1]!;
    expect(photo.spread[0]).toBeGreaterThan(HARD_SPREAD.L);
    expect(photo.target.tolerance).toEqual(SOFT_TOLERANCE);
    expect(cells[0]!.target.tolerance).toEqual(HARD_TOLERANCE);
    expect(cells[0]!.spread[0]).toBeLessThan(0.01);
  });

  test('тон и хрома — только у цветной ячейки: хрома среднего не меньше NEUTRAL_CHROMA', () => {
    const colors: Rgb8[] = [SHADES[0]!, SHADES[2]!, [128, 124, 120], SHADES[3]!, [170, 140, 105], SHADES[1]!];
    const cells = extractCells(imageLab(draw({ ...size, color: (r, c) => colors[r * 3 + c]! })), grid);
    const chroma = (c: Rgb8) => Math.hypot(lab8(c)[1], lab8(c)[2]);
    expect(chroma(colors[2]!)).toBeLessThan(NEUTRAL_CHROMA);
    expect(chroma(colors[4]!)).toBeGreaterThan(NEUTRAL_CHROMA);
    expect(cells.map((c) => c.target.hue !== undefined)).toEqual([false, true, false, true, true, false]);
    // Без тона нет и хромы: у серой ячейки цвет любой.
    expect(cells.map((c) => c.target.chroma !== undefined)).toEqual([false, true, false, true, true, false]);
    const [, warm] = cells;
    const [, a, b] = lab8(SHADES[2]!);
    expect(warm!.target.chroma).toBeCloseTo(Math.hypot(a, b), 4);
    expect(warm!.target.hue).toBeCloseTo(((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, 2);
  });

  test('ручная сетка — в координатах картинки: ячейки там, где их поставили', () => {
    const image = imageLab(draw({ width: 200, height: 200, grid: emptyGrid(), background: [255, 255, 255] }));
    // Чёрный прямоугольник накрывает центральные 60% первой ячейки ручной сетки, но не соседней.
    for (let y = 33; y < 67; y++) for (let x = 105; x < 155; x++) image.data.set([0, 0, 0], (y * 200 + x) * 3);
    const manual: ImageGrid = { left: 100, top: 30, cellWidth: 60, cellHeight: 40, gapX: 0, gapY: 0, rows: 1 };
    const cells = extractCells(image, manual);
    expect(cells.map((c) => [c.row, c.column])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    expect(cells[0]!.target.L).toBe(0);
    expect(cells[0]!.sample).toEqual({ x0: 112, y0: 38, x1: 148, y1: 62 });
    expect(cells[1]!.target.L).toBe(1);
  });

  test('паттерн картинки: источник image, период — число рядов, клетки по рядам, режим публикации — вычисленный', () => {
    const cells = extractCells(imageLab(draw(size)), grid);
    const pattern = imagePattern(cells);
    expect(pattern.source).toBe('image');
    expect(pattern.periodRows).toBe(2);
    expect(pattern.cells).toEqual(cells.map((c) => c.target));
    expect(pattern.postingMode).toBe(postingModeOf(pattern.cells));
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cells.map((c) => c.row * 3 + c.column)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('ручная правка сетки', () => {
  const grid: ImageGrid = { left: 40, top: 40, cellWidth: 300, cellHeight: 400, gapX: 15, gapY: 20, rows: 4 };
  const size = { width: 1050, height: 1800 };

  test('рамка: край двигается, промежуток тот же, ячейки поровну', () => {
    const left = dragGridLine(grid, 'x', { kind: 'frame-start' }, 100, size);
    expect(gridFrame(left)).toMatchObject({ left: 100, right: gridFrame(grid).right });
    expect(left.gapX).toBe(15);
    expect(left.cellWidth).toBeCloseTo((gridFrame(grid).right - 100 - 30) / 3, 9);
    // Нижний край поднят на ряд: ячейки стали ниже, а при «Рядов: 3» — снова прежние.
    const raised = dragGridLine(grid, 'y', { kind: 'frame-end' }, gridFrame(grid).bottom - 420, size);
    expect(raised.rows).toBe(4);
    const three = setGridRows(raised, 3);
    expect(three.rows).toBe(3);
    expect(three.cellHeight).toBeCloseTo(400, 9);
    expect(gridFrame(three)).toEqual(gridFrame(raised));
  });

  test('край рамки не выходит за картинку и не сжимает ячейки меньше MIN_GRID_CELL', () => {
    expect(gridFrame(dragGridLine(grid, 'x', { kind: 'frame-start' }, -50, size)).left).toBe(0);
    expect(gridFrame(dragGridLine(grid, 'y', { kind: 'frame-end' }, 5000, size)).bottom).toBe(1800);
    const squeezed = dragGridLine(grid, 'x', { kind: 'frame-end' }, 0, size);
    expect(squeezed.cellWidth).toBe(MIN_GRID_CELL);
    expect(squeezed.gapX).toBe(0);
    expect(gridFrame(squeezed).left).toBe(40);
  });

  test('граница ячейки: рамка на месте, меняется промежуток, линия идёт за указателем', () => {
    const frame = gridFrame(grid);
    // Правый край первой ячейки — на 340 + 3: ячейки шире, промежуток уже.
    const narrower = dragGridLine(grid, 'x', { kind: 'cell-end', cell: 0 }, 343, size);
    expect(gridFrame(narrower)).toEqual(frame);
    expect(narrower.left + narrower.cellWidth).toBeCloseTo(343, 9);
    expect(narrower.gapX).toBeCloseTo(15 - 4.5, 9);
    // Левый край второй ячейки — вправо: промежуток шире.
    const wider = dragGridLine(grid, 'x', { kind: 'cell-start', cell: 1 }, 365, size);
    expect(gridFrame(wider)).toEqual(frame);
    expect(wider.left + wider.cellWidth + wider.gapX).toBeCloseTo(365, 9);
    expect(wider.gapX).toBeGreaterThan(15);
    // Промежуток не меньше нуля.
    expect(dragGridLine(grid, 'x', { kind: 'cell-start', cell: 2 }, 0, size).gapX).toBe(0);
    // Ряд: нижний край второго ряда.
    const rows = dragGridLine(grid, 'y', { kind: 'cell-end', cell: 1 }, 870, size);
    expect(rows.top + 2 * rows.cellHeight + rows.gapY).toBeCloseTo(870, 9);
    expect(gridFrame(rows)).toEqual(frame);
  });

  test('линии оси: края рамки и края ячеек по порядку', () => {
    expect(gridLines(grid, 'x')).toEqual([
      { line: { kind: 'frame-start' }, position: 40 },
      { line: { kind: 'cell-end', cell: 0 }, position: 340 },
      { line: { kind: 'cell-start', cell: 1 }, position: 355 },
      { line: { kind: 'cell-end', cell: 1 }, position: 655 },
      { line: { kind: 'cell-start', cell: 2 }, position: 670 },
      { line: { kind: 'frame-end' }, position: 970 },
    ]);
    expect(gridLines(grid, 'y')).toHaveLength(2 + 2 * 3);
    expect(gridLines({ ...grid, rows: 1 }, 'y').map((l) => l.line.kind)).toEqual(['frame-start', 'frame-end']);
  });

  test('«Рядов»: рамка на месте, от 1 до 30; если ячейки стали бы меньше минимума — промежуток уже', () => {
    const one = setGridRows(grid, 1);
    expect(one.rows).toBe(1);
    expect(one.cellHeight).toBe(gridFrame(grid).bottom - 40);
    expect(setGridRows(grid, 0).rows).toBe(1);
    const many = setGridRows(grid, 99);
    expect(many.rows).toBe(30);
    expect(gridFrame(many)).toEqual(gridFrame(grid));
    expect(many.cellHeight).toBeGreaterThanOrEqual(MIN_GRID_CELL);
    const tight = setGridRows({ ...grid, top: 0, cellHeight: 10, gapY: 100, rows: 2 }, 3);
    expect(tight.cellHeight).toBeGreaterThanOrEqual(MIN_GRID_CELL);
    expect(gridFrame(tight).bottom).toBeCloseTo(120, 9);
  });
});
