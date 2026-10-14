// Паттерн из изображения с квадратами (docs/spec.md, «Модуль 4. Паттерны»; docs/decisions/0024-pattern-image.md).
// Картинка — регулярная сетка 3 × N: равные ячейки, равные промежутки, поля любые. Сетку ищут профили градиента
// OKLab по колонкам и строкам: пики профиля — края ячеек, регулярная модель выбирается по тому, сколько энергии
// краёв она объясняет и сколько её краёв подтверждено. Из каждой ячейки берутся центральные 60%: среднее OKLab
// точек — цель, разброс решает, жёсткая она (заливка) или мягкая (фото). Всё в координатах картинки, которую
// индексатор прочитал decodeSrgb и уменьшил до PATTERN_IMAGE_MAX_SIDE; в проект картинка не попадает.
import { linearSrgbToOklab } from '../color/oklab';
import { srgbToLinear } from '../color/transfer';
import type { RgbaImage } from '../image/sample';
import { NEUTRAL_CHROMA } from '../metrics/features';
import type { Pattern, Ratio, SlotTarget, Vec3 } from '../project/types';
import { hardTarget, softTarget, targetColorFromAb, type TargetColor } from './levels';
import { makePattern, PATTERN_COLUMNS, PATTERN_MAX_ROWS } from './pattern';

/** Длинная сторона картинки после чтения, px: больше для поиска сетки не нужно, а память ограничена. */
export const PATTERN_IMAGE_MAX_SIDE = 1600;
/** Доля стороны ячейки, из которой берётся цель: края портят скругления, ореол JPEG и неточность сетки. */
export const CELL_SAMPLE_FRACTION = 0.6;
/** Разброс точек (стандартное отклонение), меньше которого ячейка — плоская заливка: цель жёсткая. */
export const HARD_SPREAD = { L: 0.03, ab: 0.02 } as const;
/** Ячейка не меньше, px: и при подборе, и при ручной правке. */
export const MIN_GRID_CELL = 8;

/** Регулярная сетка 3 × rows в координатах картинки: px, от левого верхнего угла, края точек — целые числа. */
export interface ImageGrid {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  rows: number;
}

/** OKLab каждой точки подряд (L, a, b), строки сверху вниз. */
export interface LabImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface GradientProfiles {
  /** columns[x] — средний по строкам ΔE OKLab между точками x − 1 и x; длина width + 1, края картинки — 0. */
  columns: Float64Array;
  /** rows[y] — то же по колонкам между строками y − 1 и y; длина height + 1. */
  rows: Float64Array;
}

export interface GridDetection {
  grid: ImageGrid;
  /** По оси сетка найдена; иначе — запасная разметка по пропорциям сетки (fallbackGrid). */
  found: { columns: boolean; rows: boolean };
  /** Оценка лучшей модели оси, 0..1: найдена, если не меньше FOUND_SCORE. */
  score: { columns: number; rows: number };
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Точки поля замера: [x0, x1) × [y0, y1). */
export interface SampleRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ImageCell {
  /** Номер клетки периода: по рядам, слева направо. */
  index: number;
  row: number;
  column: number;
  rect: CellRect;
  sample: SampleRect;
  /** Среднее OKLab точек поля. */
  mean: Vec3;
  /** Стандартное отклонение L, a и b точек поля. */
  spread: Vec3;
  target: SlotTarget;
}

// ─── OKLab и профили ────────────────────────────────────────────────────────

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** OKLab точек картинки — тот же перевод, что у метрик плиток: sRGB 8 бит → линейный → OKLab. */
export function imageLab(image: RgbaImage): LabImage {
  const { width, height, data } = image;
  const channels = image.channels ?? 4;
  const count = width * height;
  if (data.length < count * channels) throw new Error('Картинка: мало данных');
  const out = new Float32Array(count * 3);
  // Шаблоны — почти сплошь заливки: у точки того же цвета, что предыдущая, перевод не повторяется.
  let previous = -1;
  let L = 0;
  let a = 0;
  let b = 0;
  for (let p = 0, i = 0; p < count; p++, i += channels) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const bl = data[i + 2] as number;
    const key = (r << 16) | (g << 8) | bl;
    if (key !== previous) {
      [L, a, b] = linearSrgbToOklab([LINEAR[r] as number, LINEAR[g] as number, LINEAR[bl] as number]);
      previous = key;
    }
    out[p * 3] = L;
    out[p * 3 + 1] = a;
    out[p * 3 + 2] = b;
  }
  return { width, height, data: out };
}

/** Профили градиента: края ячеек — вертикальные и горизонтальные линии через всю сетку, в профиле это пики. */
export function gradientProfiles(lab: LabImage): GradientProfiles {
  const { width, height, data } = lab;
  const columns = new Float64Array(width + 1);
  const rows = new Float64Array(height + 1);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x > 0) {
        columns[x] = (columns[x] as number) + distance(data, i, i - 3);
      }
      if (y > 0) rowSum += distance(data, i, i - width * 3);
    }
    if (y > 0) rows[y] = rowSum / width;
  }
  for (let x = 1; x < width; x++) columns[x] = (columns[x] as number) / height;
  return { columns, rows };
}

function distance(data: Float32Array, i: number, j: number): number {
  const dL = (data[i] as number) - (data[j] as number);
  const da = (data[i + 1] as number) - (data[j + 1] as number);
  const db = (data[i + 2] as number) - (data[j + 2] as number);
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ─── Подбор регулярной сетки ────────────────────────────────────────────────

/** Пик профиля — максимум в окрестности ±PEAK_RADIUS: размытый край (JPEG, уменьшение) — один пик. */
const PEAK_RADIUS = 3;
/** Сильнейших пиков — кандидатов в края ячеек. */
const PEAK_CANDIDATES = 40;
/** Край модели подтверждён пиком не дальше, px. */
const MATCH_RADIUS = 2;
/** Подтверждение значимо, если пик не слабее этой доли сильнейшего: слабые пики — шум и детали фото. */
const SIGNIFICANT_FRACTION = 0.15;
/** Сильнейший пик слабее — краёв нет вовсе (ровная заливка, шум). */
const MIN_EDGE = 0.01;
/** Оценка модели, начиная с которой сетка считается найденной. */
export const FOUND_SCORE = 0.75;
/** Промежуток не больше этой доли ячейки. */
const MAX_GAP_FRACTION = 0.5;
/** Три ячейки с промежутками занимают не меньше этой доли ширины. */
const MIN_COLUMNS_SPAN = 0.4;
/** Высота ячейки — в этих пределах от ширины: 1:1, 4:5 и 3:4 с запасом. */
const ROW_ASPECT_RANGE: readonly [number, number] = [0.5, 2];
/** Край на расстоянии до BORDER от края картинки — сам край картинки, градиента там нет. */
const BORDER = 1;
/** Модель может выйти за картинку не больше, px: края кандидатов целые. */
const SLACK = 1;
/** Разные оценки, равные с этой точностью, — ничья: тогда выигрывает сетка, занимающая больше картинки. */
const SCORE_EPSILON = 1e-9;

/** Сетка по одной оси: начало, ячейка, промежуток, число ячеек. */
interface Axis {
  start: number;
  cell: number;
  gap: number;
  count: number;
}

interface AxisProfile {
  length: number;
  profile: Float64Array;
  /** Подставка профиля — медиана: от неё считается сила пика. */
  baseline: number;
  /** Сила пика в его позиции, 0 вне пиков. */
  peakAt: Float64Array;
  /** Позиции пиков-кандидатов и края картинки, по возрастанию. */
  candidates: number[];
  /** Сумма квадратов значимых пиков: энергия краёв, которую должна объяснить модель. */
  energy: number;
  /** Порог значимого подтверждения. */
  significant: number;
  max: number;
}

function axisProfile(profile: Float64Array): AxisProfile {
  const length = profile.length - 1;
  const peakAt = new Float64Array(profile.length);
  const peaks: number[] = [];
  // Модуль градиента у шума положителен: профиль шумной картинки лежит на подставке. Сила пика — над медианой.
  const baseline = median(profile.subarray(1, length));
  let max = 0;
  let energy = 0;
  for (let x = 1; x < length; x++) {
    const raw = profile[x] as number;
    const v = raw - baseline;
    if (v <= 0) continue;
    let isPeak = true;
    for (let d = -PEAK_RADIUS; d <= PEAK_RADIUS && isPeak; d++) {
      if (d === 0) continue;
      const w = profile[x + d] ?? 0;
      // На ровной вершине пик — первая точка.
      if (w > raw || (w === raw && d < 0)) isPeak = false;
    }
    if (!isPeak) continue;
    peakAt[x] = v;
    peaks.push(x);
    if (v > max) max = v;
  }
  // Энергия — только значимых пиков: шум JPEG и мелкие детали фото дают сотни слабых пиков.
  const significant = SIGNIFICANT_FRACTION * max;
  for (const x of peaks) {
    const v = peakAt[x] as number;
    if (v >= significant) energy += v * v;
  }
  const strongest = [...peaks].sort((a, b) => (peakAt[b] as number) - (peakAt[a] as number) || a - b).slice(0, PEAK_CANDIDATES);
  const candidates = [...new Set([0, ...strongest, length])].sort((a, b) => a - b);
  return { length, profile, baseline, peakAt, candidates, energy, significant, max };
}

function median(values: Float64Array): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)] as number;
}

interface Score {
  score: number;
  /** Длина сетки по оси: при равной оценке выигрывает та, что занимает больше картинки. */
  span: number;
}

/** Края модели: начало и конец каждой ячейки; при нулевом промежутке общий край считается один раз. */
function* axisEdges(axis: Axis): Generator<{ position: number; cells: number; gaps: number }> {
  const { start, cell, gap, count } = axis;
  for (let n = 0; n < count; n++) {
    if (n === 0 || gap > 0) yield { position: start + n * (cell + gap), cells: n, gaps: n };
    yield { position: start + n * (cell + gap) + cell, cells: n + 1, gaps: n };
  }
}

/**
 * Оценка модели — F1 двух долей: сколько энергии краёв (квадратов пиков) она объясняет и какая доля её
 * внутренних краёв подтверждена значимым пиком. Края на краю картинки не считаются: градиента там нет.
 * Перебирает число ячеек от 1 до maxCount и возвращает лучшее из разрешённых.
 */
function scoreCounts(
  profile: AxisProfile,
  start: number,
  cell: number,
  gap: number,
  maxCount: number,
  allowed: (count: number) => boolean,
): { count: number; score: Score } | null {
  let edges = 0;
  let confirmed = 0;
  let explained = 0;
  let lastPeak = -Infinity;
  let best: { count: number; score: Score } | null = null;
  const add = (position: number) => {
    if (position <= BORDER || position >= profile.length - BORDER) return;
    edges++;
    const peak = matchPeak(profile, position, lastPeak);
    if (peak === null) return;
    lastPeak = peak;
    const v = profile.peakAt[peak] as number;
    if (v < profile.significant) return;
    explained += v * v;
    confirmed++;
  };
  for (let n = 0; n < maxCount; n++) {
    const from = start + n * (cell + gap);
    const to = from + cell;
    if (to > profile.length + SLACK) break;
    if (n === 0 || gap > 0) add(from);
    add(to);
    if (!allowed(n + 1) || edges === 0) continue;
    const precision = confirmed / edges;
    const recall = profile.energy > 0 ? explained / profile.energy : 0;
    const score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const candidate = { count: n + 1, score: { score, span: to - start } };
    if (!best || better(candidate.score, best.score)) best = candidate;
  }
  return best;
}

function better(a: Score, b: Score): boolean {
  if (a.score > b.score + SCORE_EPSILON) return true;
  return a.score >= b.score - SCORE_EPSILON && a.span > b.span;
}

/** Сильнейший пик в ±MATCH_RADIUS от края, кроме уже занятого предыдущим краем. */
function matchPeak(profile: AxisProfile, position: number, taken: number): number | null {
  const center = Math.round(position);
  let best: number | null = null;
  for (let x = center - MATCH_RADIUS; x <= center + MATCH_RADIUS; x++) {
    const v = profile.peakAt[x] ?? 0;
    if (v <= 0 || x === taken) continue;
    if (best === null || v > (profile.peakAt[best] as number)) best = x;
  }
  return best;
}

/**
 * Лучшая регулярная модель оси. Кандидаты — тройки краёв (u, v, w): ячейка [u, v] и начало следующей w,
 * то есть ячейка v − u и промежуток w − v; ячейка — k-я по счёту, отсюда начало сетки. Модель уточняется
 * наименьшими квадратами по подтверждённым краям.
 */
function fitAxis(
  profile: AxisProfile,
  cellRange: readonly [number, number],
  counts: readonly [number, number],
  minSpan = 0,
): { axis: Axis; score: number } | null {
  if (profile.max < MIN_EDGE) return null;
  const { candidates } = profile;
  const [minCount, maxCount] = counts;
  const allowed = (count: number) => count >= minCount && count <= maxCount;
  const seen = new Set<string>();
  let best: { axis: Axis; score: Score } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i] as number;
    for (let j = i + 1; j < candidates.length; j++) {
      const v = candidates[j] as number;
      const cell = v - u;
      if (cell < cellRange[0]) continue;
      if (cell > cellRange[1]) break;
      for (let l = j; l < candidates.length; l++) {
        const w = candidates[l] as number;
        const gap = w - v;
        if (gap > cell * MAX_GAP_FRACTION) break;
        for (let k = 0; k < maxCount; k++) {
          const start = u - k * (cell + gap);
          if (start < -SLACK) break;
          const key = `${start},${cell},${gap}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const result = scoreCounts(profile, start, cell, gap, maxCount, (count) => allowed(count) && count * cell + (count - 1) * gap >= minSpan);
          if (result && (!best || better(result.score, best.score))) {
            best = { axis: { start, cell, gap, count: result.count }, score: result.score };
          }
        }
      }
    }
  }
  if (!best) return null;
  return { axis: refineAxis(profile, best.axis), score: best.score.score };
}

/**
 * Наименьшие квадраты по краям модели: подтверждённый значимым пиком край — центр тяжести профиля вокруг пика,
 * край на краю картинки — сам край. Неизвестные — начало, ячейка и промежуток (при нулевом промежутке — без
 * него). Если краёв мало, модель остаётся целой, как её нашли.
 */
function refineAxis(profile: AxisProfile, axis: Axis): Axis {
  const withGap = axis.gap > 0;
  const rows: number[][] = [];
  const values: number[] = [];
  let lastPeak = -Infinity;
  for (const edge of axisEdges(axis)) {
    let observed: number | null = null;
    if (edge.position <= BORDER) observed = 0;
    else if (edge.position >= profile.length - BORDER) observed = profile.length;
    else {
      const peak = matchPeak(profile, edge.position, lastPeak);
      if (peak !== null) {
        lastPeak = peak;
        if ((profile.peakAt[peak] as number) >= profile.significant) observed = centroid(profile, peak);
      }
    }
    if (observed === null) continue;
    rows.push(withGap ? [1, edge.cells, edge.gaps] : [1, edge.cells]);
    values.push(observed);
  }
  const solution = leastSquares(rows, values);
  if (!solution) return axis;
  const [start = axis.start, cell = axis.cell, gap = 0] = solution;
  if (!(cell >= MIN_GRID_CELL)) return axis;
  return { start: Math.max(0, start), cell, gap: Math.max(0, gap), count: axis.count };
}

/** Центр тяжести профиля над подставкой в пике ±1: край, размазанный на две-три точки, — между ними. */
function centroid({ profile, baseline }: AxisProfile, peak: number): number {
  let sum = 0;
  let weighted = 0;
  for (let x = peak - 1; x <= peak + 1; x++) {
    const v = Math.max(0, (profile[x] ?? 0) - baseline);
    sum += v;
    weighted += v * x;
  }
  return sum > 0 ? weighted / sum : peak;
}

/** Решение нормальных уравнений методом Гаусса; null — краёв меньше, чем неизвестных, или система вырождена. */
function leastSquares(rows: number[][], values: number[]): number[] | null {
  const n = rows[0]?.length ?? 0;
  if (n === 0 || rows.length < n) return null;
  const m = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  rows.forEach((row, r) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) (m[i] as number[])[j]! += (row[i] as number) * (row[j] as number);
      (m[i] as number[])[n]! += (row[i] as number) * (values[r] as number);
    }
  });
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number)) pivot = r;
    if (Math.abs((m[pivot] as number[])[c] as number) < 1e-9) return null;
    [m[c], m[pivot]] = [m[pivot] as number[], m[c] as number[]];
    const row = m[c] as number[];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const other = m[r] as number[];
      const f = (other[c] as number) / (row[c] as number);
      for (let j = c; j <= n; j++) other[j] = (other[j] as number) - f * (row[j] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** Высота ячейки на ширину по пропорциям сетки. */
function cellAspect(ratio: Ratio): number {
  return ratio === '1:1' ? 1 : 4 / 3;
}

/** Если сетку подобрать не удалось: вся картинка — 3 × N ячеек по пропорциям сетки, без полей и промежутков. */
export function fallbackGrid(width: number, height: number, ratio: Ratio): ImageGrid {
  const cellWidth = width / PATTERN_COLUMNS;
  const rows = clampRows(Math.round(height / (cellWidth * cellAspect(ratio))));
  return { left: 0, top: 0, cellWidth, cellHeight: height / rows, gapX: 0, gapY: 0, rows };
}

function clampRows(rows: number): number {
  return Math.min(PATTERN_MAX_ROWS, Math.max(1, Math.round(rows)));
}

/**
 * Сетка 3 × N на картинке: по колонкам — три ячейки, по строкам — число рядов, какое объясняет профиль лучше.
 * Ось, где сетку подобрать не удалось, размечается по пропорциям сетки (fallbackGrid).
 */
export function detectGrid(lab: LabImage, ratio: Ratio, profiles: GradientProfiles = gradientProfiles(lab)): GridDetection {
  const { width, height } = lab;
  const fallback = fallbackGrid(width, height, ratio);
  // Три ячейки и два промежутка не больше половины ячейки — не шире четырёх ячеек: отсюда нижний предел ячейки.
  const columns = fitAxis(
    axisProfile(profiles.columns),
    [Math.max(MIN_GRID_CELL, (MIN_COLUMNS_SPAN * width) / (PATTERN_COLUMNS + 1)), width / PATTERN_COLUMNS + SLACK],
    [PATTERN_COLUMNS, PATTERN_COLUMNS],
    MIN_COLUMNS_SPAN * width,
  );
  const foundColumns = columns !== null && columns.score >= FOUND_SCORE;
  const x: Axis = foundColumns
    ? columns.axis
    : { start: fallback.left, cell: fallback.cellWidth, gap: fallback.gapX, count: PATTERN_COLUMNS };
  const rows = fitAxis(
    axisProfile(profiles.rows),
    [Math.max(MIN_GRID_CELL, x.cell * ROW_ASPECT_RANGE[0]), x.cell * ROW_ASPECT_RANGE[1]],
    [1, PATTERN_MAX_ROWS],
  );
  const foundRows = rows !== null && rows.score >= FOUND_SCORE;
  let y: Axis = foundRows ? rows.axis : fallbackRows(x, foundColumns, height, ratio, fallback);
  // У одного ряда промежутка по высоте не видно: берём промежуток колонок — пригодится, если добавить ряды вручную.
  if (y.count === 1) y = { ...y, gap: x.gap };
  return {
    grid: { left: x.start, top: y.start, cellWidth: x.cell, cellHeight: y.cell, gapX: x.gap, gapY: y.gap, rows: y.count },
    found: { columns: foundColumns, rows: foundRows },
    score: { columns: columns?.score ?? 0, rows: rows?.score ?? 0 },
  };
}

/**
 * Ряды по пропорциям сетки: если колонки найдены — с теми же полями и промежутком, высота ячейки — по её ширине,
 * рядов столько, сколько помещается; иначе — запасная сетка на всю картинку.
 */
function fallbackRows(x: Axis, foundColumns: boolean, height: number, ratio: Ratio, fallback: ImageGrid): Axis {
  const whole: Axis = { start: fallback.top, cell: fallback.cellHeight, gap: fallback.gapY, count: fallback.rows };
  if (!foundColumns) return whole;
  const span = height - 2 * x.start;
  const pitch = x.cell * cellAspect(ratio) + x.gap;
  const count = clampRows((span + x.gap) / pitch);
  const cell = (span - (count - 1) * x.gap) / count;
  return cell >= MIN_GRID_CELL ? { start: x.start, cell, gap: x.gap, count } : whole;
}

// ─── Ячейки и цели ──────────────────────────────────────────────────────────

/** Внешние края сетки. */
export function gridFrame(grid: ImageGrid): { left: number; top: number; right: number; bottom: number } {
  return {
    left: grid.left,
    top: grid.top,
    right: grid.left + PATTERN_COLUMNS * grid.cellWidth + (PATTERN_COLUMNS - 1) * grid.gapX,
    bottom: grid.top + grid.rows * grid.cellHeight + (grid.rows - 1) * grid.gapY,
  };
}

export function cellRect(grid: ImageGrid, row: number, column: number): CellRect {
  return {
    x: grid.left + column * (grid.cellWidth + grid.gapX),
    y: grid.top + row * (grid.cellHeight + grid.gapY),
    w: grid.cellWidth,
    h: grid.cellHeight,
  };
}

/**
 * Поле замера — центральные 60% ячейки по каждой стороне: точки, чьи центры внутри, в пределах картинки.
 * Меньше точки не бывает: у крошечной ячейки берётся точка в её центре.
 */
export function sampleRect(rect: CellRect, width: number, height: number): SampleRect {
  const [x0, x1] = sampleSpan(rect.x, rect.w, width);
  const [y0, y1] = sampleSpan(rect.y, rect.h, height);
  return { x0, y0, x1, y1 };
}

function sampleSpan(from: number, size: number, limit: number): [number, number] {
  const margin = (size * (1 - CELL_SAMPLE_FRACTION)) / 2;
  const a = Math.min(limit, Math.max(0, Math.ceil(from + margin - 0.5)));
  const b = Math.min(limit, Math.max(0, Math.ceil(from + size - margin - 0.5)));
  if (b > a) return [a, b];
  const center = Math.min(limit - 1, Math.max(0, Math.floor(from + size / 2)));
  return [center, center + 1];
}

/** Цели ячеек сетки по рядам, слева направо: среднее OKLab центральных 60%, жёсткая или мягкая по разбросу. */
export function extractCells(lab: LabImage, grid: ImageGrid): ImageCell[] {
  const cells: ImageCell[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < PATTERN_COLUMNS; column++) {
      const rect = cellRect(grid, row, column);
      const sample = sampleRect(rect, lab.width, lab.height);
      const { mean, spread } = sampleStats(lab, sample);
      cells.push({ index: cells.length, row, column, rect, sample, mean, spread, target: cellTarget(mean, spread) });
    }
  }
  return cells;
}

function sampleStats(lab: LabImage, { x0, y0, x1, y1 }: SampleRect): { mean: Vec3; spread: Vec3 } {
  const sum = [0, 0, 0];
  const squares = [0, 0, 0];
  const { data, width } = lab;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c] as number;
        sum[c]! += v;
        squares[c]! += v * v;
      }
    }
  }
  const n = Math.max(1, (x1 - x0) * (y1 - y0));
  const mean = sum.map((s) => s / n) as Vec3;
  const spread = squares.map((s, c) => Math.sqrt(Math.max(0, s / n - (mean[c] as number) ** 2))) as Vec3;
  return { mean, spread };
}

/** Цель ячейки: L среднего; тон и хрома — только у цветной ячейки; разброс меньше HARD_SPREAD — жёсткая. */
function cellTarget([L, a, b]: Vec3, [sL, sa, sb]: Vec3): SlotTarget {
  const hard = sL < HARD_SPREAD.L && sa < HARD_SPREAD.ab && sb < HARD_SPREAD.ab;
  const color: TargetColor = targetColorFromAb(a, b, NEUTRAL_CHROMA);
  const colored = color.hue !== undefined ? color : undefined;
  return hard ? hardTarget(L, colored) : softTarget(L, colored);
}

/** Паттерн из ячеек: источник image, период — число рядов, режим публикации считает makePattern. */
export function imagePattern(cells: readonly ImageCell[]): Pattern {
  return makePattern(
    'image',
    cells.map((cell) => cell.target),
  );
}

// ─── Ручная правка ──────────────────────────────────────────────────────────

export type GridAxis = 'x' | 'y';

/**
 * Линия сетки, которую тянут мышью: край рамки (начало или конец) или край ячейки — конец ячейки cell или
 * начало ячейки cell. Рамка двигает свой край, промежуток прежний; край ячейки меняет промежуток, рамка на месте.
 */
export type GridLine = { kind: 'frame-start' } | { kind: 'frame-end' } | { kind: 'cell-end'; cell: number } | { kind: 'cell-start'; cell: number };

interface AxisParams {
  start: number;
  cell: number;
  gap: number;
  count: number;
}

function axisOf(grid: ImageGrid, axis: GridAxis): AxisParams {
  return axis === 'x'
    ? { start: grid.left, cell: grid.cellWidth, gap: grid.gapX, count: PATTERN_COLUMNS }
    : { start: grid.top, cell: grid.cellHeight, gap: grid.gapY, count: grid.rows };
}

function withAxis(grid: ImageGrid, axis: GridAxis, { start, cell, gap, count }: AxisParams): ImageGrid {
  return axis === 'x'
    ? { ...grid, left: start, cellWidth: cell, gapX: gap }
    : { ...grid, top: start, cellHeight: cell, gapY: gap, rows: count };
}

/** Ячейки поровну в рамке [start, start + span]; промежуток — не больше, чем позволяет MIN_GRID_CELL. */
function fitSpan(start: number, span: number, gap: number, count: number): AxisParams {
  const maxGap = count > 1 ? Math.max(0, (span - count * MIN_GRID_CELL) / (count - 1)) : 0;
  const g = count > 1 ? Math.min(Math.max(0, gap), maxGap) : gap;
  return { start, cell: Math.max(MIN_GRID_CELL, (span - (count - 1) * g) / count), gap: g, count };
}

/** Линии оси: края рамки и края ячеек, с позициями в координатах картинки. */
export function gridLines(grid: ImageGrid, axis: GridAxis): { line: GridLine; position: number }[] {
  const { start, cell, gap, count } = axisOf(grid, axis);
  const lines: { line: GridLine; position: number }[] = [{ line: { kind: 'frame-start' }, position: start }];
  for (let j = 0; j < count - 1; j++) {
    lines.push({ line: { kind: 'cell-end', cell: j }, position: start + (j + 1) * cell + j * gap });
    lines.push({ line: { kind: 'cell-start', cell: j + 1 }, position: start + (j + 1) * (cell + gap) });
  }
  lines.push({ line: { kind: 'frame-end' }, position: start + count * cell + (count - 1) * gap });
  return lines;
}

/**
 * Линия сетки протянута до position (координаты картинки). Края рамки не выходят за картинку и не сжимают ячейки
 * меньше MIN_GRID_CELL — тогда сначала сужается промежуток. Край ячейки ставит промежуток так, чтобы линия
 * прошла через position, рамка и равенство ячеек сохраняются.
 */
export function dragGridLine(grid: ImageGrid, axis: GridAxis, line: GridLine, position: number, size: { width: number; height: number }): ImageGrid {
  const limit = axis === 'x' ? size.width : size.height;
  const p = axisOf(grid, axis);
  const end = p.start + p.count * p.cell + (p.count - 1) * p.gap;
  const minSpan = p.count * MIN_GRID_CELL;
  if (line.kind === 'frame-start') {
    const start = Math.min(Math.max(0, position), end - minSpan);
    return withAxis(grid, axis, fitSpan(start, end - start, p.gap, p.count));
  }
  if (line.kind === 'frame-end') {
    const to = Math.max(Math.min(limit, position), p.start + minSpan);
    return withAxis(grid, axis, fitSpan(p.start, to - p.start, p.gap, p.count));
  }
  if (p.count < 2) return grid;
  const span = end - p.start;
  const n = p.count;
  // Край ячейки линеен по промежутку при неизменной рамке: c = (span − (n − 1)·g) / n.
  const j = line.cell;
  const [offset, slope] =
    line.kind === 'cell-end' ? [((j + 1) * span) / n, (j - n + 1) / n] : [(j * span) / n, j / n];
  if (slope === 0) return grid;
  const gap = (position - p.start - offset) / slope;
  return withAxis(grid, axis, fitSpan(p.start, span, gap, n));
}

/** «Рядов»: от 1 до PATTERN_MAX_ROWS, рамка на месте, ячейки поровну. */
export function setGridRows(grid: ImageGrid, rows: number): ImageGrid {
  const count = clampRows(rows);
  const span = gridFrame(grid).bottom - grid.top;
  return withAxis(grid, 'y', fitSpan(grid.top, span, grid.gapY, count));
}
