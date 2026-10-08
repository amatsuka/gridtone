// Калибровочная карта (docs/spec.md, «Модуль 2»; docs/decisions/0016-calibration-card.md).
// Gridtone отдаёт синтетическую карту патчей; пользователь накладывает на неё LUT в своём редакторе
// и возвращает файл. Замер патчей сравнивается с тем, что показывает Gridtone, — с проходом образа
// в core, — и с двумя частыми ошибками: LUT не применён и LUT применён дважды.
import { bakePipeline, type PipelineParams } from '../color/bake';
import { deltaE2000, srgbToCielab } from '../color/deltaE';
import { applyBaked } from '../color/pipeline';
import type { Rgb } from '../color/srgb';
import { lchToSrgb } from '../color/swatches';
import type { RgbaImage } from '../image/sample';

/** Размер карты. Не квадрат и далеко от 3:4: повёрнутая на 90° карта не пройдёт проверку пропорций. */
export const CARD_WIDTH = 1800;
export const CARD_HEIGHT = 768;

/** Сетка патчей: поля, сторона патча и промежуток, 24 колонки × 7 строк. */
const MARGIN = 40;
const PATCH = 64;
const GAP = 8;
const COLUMNS = 24;
const ROWS = 7;
/** Градиенты под патчами: отступ, высота полосы, промежуток между полосами. */
const GRADIENT_TOP = MARGIN + ROWS * PATCH + (ROWS - 1) * GAP + 32;
const GRADIENT_HEIGHT = 48;
/** Фон — тёмно-серый, как рамка у мишеней цвета. */
const BACKGROUND: Rgb8 = [51, 51, 51];

/** «Совпадает»: средний ΔE2000 по патчам и худший патч. Стартовые значения, их калибрует ручной чек-лист. */
export const CARD_LIMITS = { mean: 1, max: 3 } as const;
/** Средний ΔE, до которого замер считается объяснённым моделью «без LUT» или «LUT дважды». */
export const CARD_MODEL_FIT = 2;
/** Пропорции возвращённой карты должны совпасть с картой с такой точностью. */
export const CARD_RATIO_TOLERANCE = 0.01;
/** Меньше четверти размера поле замера уже меньше 8 × 8 точек. */
export const CARD_MIN_SCALE = 0.25;
/** Худших патчей в отчёте. */
export const CARD_WORST_COUNT = 8;

export type Rgb8 = readonly [number, number, number];

export interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CardPatchGroup = 'gray' | 'hue' | 'neutral' | 'skin' | 'edge' | 'light';

export interface CardPatch {
  index: number;
  group: CardPatchGroup;
  /** Подпись для отчёта: «серый 128», «тон 120°, L 0.6», «кожа #f1c27d». */
  label: string;
  /** Цвет патча в карте, sRGB 8 бит. */
  rgb8: Rgb8;
  rect: CardRect;
  /** Поле замера — центральная половина патча: края портят ореол JPEG и уменьшение. */
  field: CardRect;
}

/** Градиенты — для глаза, в замер не входят: серая рампа, тона, тени и света крупно. */
export type CardGradientKind = 'gray' | 'hue' | 'ends';

export interface CardGradient {
  kind: CardGradientKind;
  rect: CardRect;
}

export interface CardLayout {
  width: number;
  height: number;
  background: Rgb8;
  patches: readonly CardPatch[];
  gradients: readonly CardGradient[];
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const to8 = (rgb: Rgb): Rgb8 => [Math.round(clamp01(rgb[0]) * 255), Math.round(clamp01(rgb[1]) * 255), Math.round(clamp01(rgb[2]) * 255)];

/** HSV → sRGB 0..1, тон в градусах. S = 1 — край охвата sRGB: один канал на нуле. */
function hsv(h: number, s: number, v: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

/** Телесные тона от светлого к тёмному. */
const SKIN = ['ffe0bd', 'ffdbac', 'f1c27d', 'e8b9a0', 'e0ac69', 'd8a48f', 'c68642', 'b07a62', 'a1665e', '8d5524', '5c3a2e', '3b2219'];

type PatchColor = Pick<CardPatch, 'group' | 'label' | 'rgb8'>;

const steps = (n: number, f: (i: number) => PatchColor) => Array.from({ length: n }, (_, i) => f(i));

/** Строки карты по 24 патча. */
function patchRows(): PatchColor[][] {
  const gray = steps(COLUMNS, (i) => {
    const v = Math.round((255 * i) / (COLUMNS - 1));
    return { group: 'gray', label: `серый ${v}`, rgb8: [v, v, v] };
  });
  // Круг тонов через 15° на трёх уровнях OKLab L; хрома 0.1 или меньше, если столько нет в охвате.
  const hues = [0.8, 0.6, 0.4].map((L) =>
    steps(COLUMNS, (i) => ({ group: 'hue', label: `тон ${i * 15}°, L ${L}`, rgb8: to8(lchToSrgb(L, 0.1, i * 15)) })),
  );
  const neutral = steps(12, (i) => ({ group: 'neutral', label: `почти серый ${i * 30}°`, rgb8: to8(lchToSrgb(0.6, 0.03, i * 30)) }));
  const skin = SKIN.map((hex): PatchColor => ({
    group: 'skin',
    label: `кожа #${hex}`,
    rgb8: [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)],
  }));
  const edge = steps(COLUMNS, (i) => ({ group: 'edge', label: `край охвата ${i * 15}°`, rgb8: to8(hsv(i * 15, 1, 1)) }));
  const darkEdge = steps(12, (i) => ({ group: 'edge', label: `тёмный край ${i * 30}°`, rgb8: to8(hsv(i * 30, 1, 0.5)) }));
  const light = steps(12, (i) => ({ group: 'light', label: `светлый ${i * 30}°`, rgb8: to8(lchToSrgb(0.93, 0.04, i * 30)) }));
  return [gray, ...hues, [...neutral, ...skin], edge, [...darkEdge, ...light]];
}

let layout: CardLayout | null = null;

/** Раскладка карты. Постоянная: от неё зависят и запись карты, и замер возвращённой. */
export function cardLayout(): CardLayout {
  if (layout) return layout;
  const rows = patchRows();
  if (rows.length !== ROWS || rows.some((row) => row.length !== COLUMNS)) throw new Error('Раскладка карты: строки не по 24 патча');
  const patches = rows.flatMap((row, r) =>
    row.map((color, c): Omit<CardPatch, 'index'> => {
      const rect = { x: MARGIN + c * (PATCH + GAP), y: MARGIN + r * (PATCH + GAP), w: PATCH, h: PATCH };
      return { ...color, rect, field: { x: rect.x + PATCH / 4, y: rect.y + PATCH / 4, w: PATCH / 2, h: PATCH / 2 } };
    }),
  );
  const width = CARD_WIDTH - 2 * MARGIN;
  const gradients = (['gray', 'hue', 'ends'] as const).map((kind, i) => ({
    kind,
    rect: { x: MARGIN, y: GRADIENT_TOP + i * (GRADIENT_HEIGHT + GAP), w: width, h: GRADIENT_HEIGHT },
  }));
  layout = { width: CARD_WIDTH, height: CARD_HEIGHT, background: BACKGROUND, patches: patches.map((p, index) => ({ ...p, index })), gradients };
  return layout;
}

/** Цвет патча, который видит редактор, sRGB 0..1: ровно 8-битное значение из карты. */
export function patchSource(patch: CardPatch): Rgb {
  return [patch.rgb8[0] / 255, patch.rgb8[1] / 255, patch.rgb8[2] / 255];
}

/** t — доля вдоль полосы, v — поперёк. */
function gradientColor(kind: CardGradientKind, t: number, v: number): Rgb {
  if (kind === 'gray') return [t, t, t];
  if (kind === 'hue') return hsv(t * 360, 1, 1);
  // Верхняя половина — тени 0…0.2, нижняя — света 0.8…1: видно, где редактор их срезает.
  const g = v < 0.5 ? 0.2 * t : 0.8 + 0.2 * t;
  return [g, g, g];
}

/** Картинка карты: RGBA 8 бит, sRGB. */
export function renderCard(): RgbaImage {
  const { width, height, background, patches, gradients } = cardLayout();
  const data = new Uint8Array(width * height * 4);
  const fill = (rect: CardRect, color: (x: number, y: number) => Rgb8) => {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const [r, g, b] = color(x, y);
        const i = (y * width + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
  };
  fill({ x: 0, y: 0, w: width, h: height }, () => background);
  for (const { kind, rect } of gradients) {
    fill(rect, (x, y) => to8(gradientColor(kind, (x - rect.x + 0.5) / rect.w, (y - rect.y + 0.5) / rect.h)));
  }
  for (const patch of patches) fill(patch.rect, () => patch.rgb8);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Возвращённая карта: 8 бит на канал, channels значений на точку (RGB или RGBA), строки сверху вниз. */
export interface CardImage {
  width: number;
  height: number;
  channels: number;
  data: ArrayLike<number>;
}

export type CardGeometry = { ok: true; scaleX: number; scaleY: number } | { ok: false; problem: 'proportions' | 'small' };

/**
 * Годится ли картинка width × height для замера. Карта возвращается целиком: размер можно менять,
 * пропорции — нет. Обрезанная или повёрнутая на 90° карта не проходит по пропорциям.
 */
export function cardGeometry(width: number, height: number): CardGeometry {
  const ratio = width / height / (CARD_WIDTH / CARD_HEIGHT);
  if (!(Math.abs(ratio - 1) <= CARD_RATIO_TOLERANCE)) return { ok: false, problem: 'proportions' };
  const scaleX = width / CARD_WIDTH;
  const scaleY = height / CARD_HEIGHT;
  if (Math.min(scaleX, scaleY) < CARD_MIN_SCALE) return { ok: false, problem: 'small' };
  return { ok: true, scaleX, scaleY };
}

/**
 * Средний цвет поля замера каждого патча, sRGB 0..1. Поле переносится в координаты картинки
 * пропорционально; берутся точки, чьи центры внутри. Суммы целые: у однотонного поля замер равен
 * цвету бит в бит при любом размере.
 */
export function measureCard(image: CardImage): Rgb[] {
  const { width, height, channels, data } = image;
  const geometry = cardGeometry(width, height);
  if (!geometry.ok) throw new Error(`Картинка ${width} × ${height} — не калибровочная карта ${CARD_WIDTH} × ${CARD_HEIGHT}`);
  if (channels < 3 || data.length < width * height * channels) throw new Error('Картинка карты: мало данных');
  const { scaleX, scaleY } = geometry;
  return cardLayout().patches.map(({ field }) => {
    const x0 = Math.ceil(field.x * scaleX - 0.5);
    const x1 = Math.ceil((field.x + field.w) * scaleX - 0.5);
    const y0 = Math.ceil(field.y * scaleY - 0.5);
    const y1 = Math.ceil((field.y + field.h) * scaleY - 0.5);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * channels;
        r += data[i] as number;
        g += data[i + 1] as number;
        b += data[i + 2] as number;
      }
    }
    const n = (x1 - x0) * (y1 - y0) * 255;
    return [r / n, g / n, b / n];
  });
}

/** Что сделал редактор: ничего, LUT, LUT дважды. */
export type CardModel = 'none' | 'lut' | 'twice';

export interface CardStats {
  mean: number;
  /** 95-й перцентиль по ближайшему рангу. */
  p95: number;
  max: number;
}

export interface CardPatchResult {
  index: number;
  label: string;
  /** Цвет патча в карте. */
  source: Rgb;
  /** Что показывает Gridtone: проход образа по цвету патча. */
  expected: Rgb;
  measured: Rgb;
  deltaE: number;
}

/**
 * - match — LUT стоит в правильной точке: замер совпал с Gridtone в пределах CARD_LIMITS;
 * - no-lut — карта вернулась без LUT;
 * - twice — LUT применён дважды;
 * - shifted — ни одна модель не объясняет замер: LUT получил не ту картинку или редактор меняет цвет.
 */
export type CardVerdict = 'match' | 'no-lut' | 'twice' | 'shifted';

export interface CardDiagnosis {
  verdict: CardVerdict;
  /** ΔE2000 замера против каждой модели; models.lut — против Gridtone. */
  models: Record<CardModel, CardStats>;
  /** Худшие патчи против Gridtone, по убыванию ΔE. */
  worst: CardPatchResult[];
  /** Образ почти не меняет цвет: карта не отличит LUT от его отсутствия. */
  weak: boolean;
}

export type CardReport =
  | { verdict: 'geometry'; problem: 'proportions' | 'small'; width: number; height: number }
  | (CardDiagnosis & { width: number; height: number });

function stats(errors: readonly number[]): CardStats {
  const sorted = [...errors].sort((a, b) => a - b);
  const sum = sorted.reduce((s, e) => s + e, 0);
  return { mean: sum / sorted.length, p95: sorted[Math.ceil(0.95 * sorted.length) - 1] as number, max: sorted.at(-1) as number };
}

const passes = (s: CardStats) => s.mean < CARD_LIMITS.mean && s.max < CARD_LIMITS.max;

/**
 * Диагноз по замеру патчей. params — проход образа (lookPipeline): ожидание — то, что видно в
 * Gridtone. Ближайшая модель выбирается по среднему ΔE2000.
 */
export function diagnoseCard(measured: readonly Rgb[], params: PipelineParams): CardDiagnosis {
  const { patches } = cardLayout();
  if (measured.length !== patches.length) throw new Error(`Замер карты: ${measured.length} патчей вместо ${patches.length}`);
  const baked = bakePipeline(params);
  const look = (c: Rgb) => applyBaked(c, baked);
  const sources = patches.map(patchSource);
  const expected = sources.map(look);
  const measuredLab = measured.map(srgbToCielab);
  const errorsOf = (prediction: readonly Rgb[]) => prediction.map((p, i) => deltaE2000(srgbToCielab(p), measuredLab[i]!));
  const lutErrors = errorsOf(expected);
  const models: Record<CardModel, CardStats> = {
    none: stats(errorsOf(sources)),
    lut: stats(lutErrors),
    twice: stats(errorsOf(expected.map(look))),
  };
  const separation = stats(sources.map((s, i) => deltaE2000(srgbToCielab(s), srgbToCielab(expected[i]!))));
  const worst = lutErrors
    .map((deltaE, index) => ({ deltaE, index }))
    .sort((a, b) => b.deltaE - a.deltaE)
    .slice(0, CARD_WORST_COUNT)
    .map(({ deltaE, index }) => ({
      index,
      label: patches[index]!.label,
      source: sources[index]!,
      expected: expected[index]!,
      measured: [...measured[index]!] as Rgb,
      deltaE,
    }));
  return { verdict: verdictOf(models), models, worst, weak: separation.mean < CARD_MODEL_FIT };
}

function verdictOf(models: Record<CardModel, CardStats>): CardVerdict {
  if (passes(models.lut)) return 'match';
  const best = (['lut', 'none', 'twice'] as const).reduce((a, b) => (models[b].mean < models[a].mean ? b : a));
  if (best === 'none' && models.none.mean < CARD_MODEL_FIT) return 'no-lut';
  if (best === 'twice' && models.twice.mean < CARD_MODEL_FIT) return 'twice';
  return 'shifted';
}

/** Проверка возвращённой карты: пропорции, замер, диагноз. */
export function checkCard(image: CardImage, params: PipelineParams): CardReport {
  const { width, height } = image;
  const geometry = cardGeometry(width, height);
  if (!geometry.ok) return { verdict: 'geometry', problem: geometry.problem, width, height };
  return { ...diagnoseCard(measureCard(image), params), width, height };
}
