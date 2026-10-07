// Проверка по кругу (docs/spec.md, «Модуль 2», «Проверка по кругу»): цвета проходят через эталонный
// конвейер и через LUT, разница — ΔE2000 в CIELAB. Порог спеки: средний < 0.5, 99-й перцентиль < 2.
// Решение принимается по тетраэдрической интерполяции (Photoshop); трилинейная (Resolve) — для сведения.
import type { PipelineParams } from '../color/bake';
import { bakePipeline } from '../color/bake';
import { deltaE2000, srgbToCielab } from '../color/deltaE';
import { applyBaked } from '../color/pipeline';
import type { Rgb } from '../color/srgb';
import { mulberry32 } from '../random';
import { bakeLut } from './bake';
import { sampleLut, type Lut3D, type LutInterpolation } from './lut3d';

export const LUT_CHECK_LIMITS = { mean: 0.5, p99: 2 } as const;

/** Размеры экспорта: 33 по умолчанию, 65 — если 33 не проходит проверку. */
export const LUT_EXPORT_SIZES = [33, 65] as const;
export type LutExportSize = (typeof LUT_EXPORT_SIZES)[number];

/** Цветов проверки: центры ячеек 17³, случайные, рампы. */
const CELL_STEPS = 17;
const RANDOM_COUNT = 20_000;
const RANDOM_SEED = 2026;
const RAMP_STEPS = 256;

export interface LutErrorStats {
  mean: number;
  /** 99-й перцентиль по ближайшему рангу. */
  p99: number;
  max: number;
  /** Вход с наибольшей ошибкой. */
  worst: Rgb;
  count: number;
}

export interface LutCheck {
  tetrahedral: LutErrorStats;
  trilinear: LutErrorStats;
  /** Проходит ли тетраэдрическая порог спеки. */
  pass: boolean;
}

/**
 * Постоянный набор цветов проверки, RGB подряд:
 * - решётка 17³ в центрах ячеек LUT размера size — там интерполяция ошибается сильнее всего;
 * - 20 000 случайных цветов с постоянным зерном;
 * - рампы по 256 шагов: серая, основные, дополнительные и тёплая.
 */
export function lutCheckColors(size: number): Float64Array {
  const n = size - 1;
  // Центры ячеек (k + 0.5)/n, 17 штук по оси, равномерно по решётке LUT. У малых LUT повторы убираются.
  const centers = [...new Set(Array.from({ length: CELL_STEPS }, (_, j) => Math.round((j * (n - 1)) / (CELL_STEPS - 1))))].map(
    (k) => (k + 0.5) / n,
  );
  const ramps: ((v: number) => Rgb)[] = [
    (v) => [v, v, v],
    (v) => [v, 0, 0],
    (v) => [0, v, 0],
    (v) => [0, 0, v],
    (v) => [0, v, v],
    (v) => [v, 0, v],
    (v) => [v, v, 0],
    (v) => [v, v * 0.8, v * 0.6],
  ];
  const out = new Float64Array((centers.length ** 3 + RANDOM_COUNT + ramps.length * RAMP_STEPS) * 3);
  let p = 0;
  const push = (r: number, g: number, b: number) => {
    out[p++] = r;
    out[p++] = g;
    out[p++] = b;
  };
  for (const b of centers) for (const g of centers) for (const r of centers) push(r, g, b);
  const random = mulberry32(RANDOM_SEED);
  for (let i = 0; i < RANDOM_COUNT; i++) push(random(), random(), random());
  for (const ramp of ramps) {
    for (let i = 0; i < RAMP_STEPS; i++) push(...ramp(i / (RAMP_STEPS - 1)));
  }
  return out;
}

/** Среднее, 99-й перцентиль и максимум. errors сортируется на месте. */
export function summarizeErrors(errors: Float64Array): Omit<LutErrorStats, 'worst'> {
  const count = errors.length;
  if (count === 0) return { mean: 0, p99: 0, max: 0, count };
  let sum = 0;
  for (const e of errors) sum += e;
  errors.sort();
  return { mean: sum / count, p99: errors[Math.ceil(0.99 * count) - 1] as number, max: errors[count - 1] as number, count };
}

export function passesLimits(stats: Pick<LutErrorStats, 'mean' | 'p99'>): boolean {
  return stats.mean < LUT_CHECK_LIMITS.mean && stats.p99 < LUT_CHECK_LIMITS.p99;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * ΔE2000 между reference(c) и LUT(c) для каждого цвета colors (RGB подряд).
 * Выход LUT срезается в 0..1, как у редактора, который пишет 8- или 16-битный файл.
 */
export function lutErrors(
  lut: Lut3D,
  reference: (rgb: Rgb) => Rgb,
  colors: Float64Array,
  interpolations: readonly LutInterpolation[],
): { errors: Float64Array[]; worst: Rgb[] } {
  const count = colors.length / 3;
  const errors = interpolations.map(() => new Float64Array(count));
  const worst = interpolations.map((): Rgb => [0, 0, 0]);
  const worstError = interpolations.map(() => -1);
  for (let i = 0; i < count; i++) {
    const c: Rgb = [colors[i * 3] as number, colors[i * 3 + 1] as number, colors[i * 3 + 2] as number];
    const expected = srgbToCielab(reference(c));
    interpolations.forEach((interpolation, k) => {
      const [r, g, b] = sampleLut(lut, c, interpolation);
      const e = deltaE2000(expected, srgbToCielab([clamp01(r), clamp01(g), clamp01(b)]));
      (errors[k] as Float64Array)[i] = e;
      if (e > (worstError[k] as number)) {
        worstError[k] = e;
        worst[k] = c;
      }
    });
  }
  return { errors, worst };
}

/** Проверка LUT против эталонной функции на наборе colors (по умолчанию — lutCheckColors). */
export function checkLut(lut: Lut3D, reference: (rgb: Rgb) => Rgb, colors = lutCheckColors(lut.size)): LutCheck {
  const { errors, worst } = lutErrors(lut, reference, colors, ['tetrahedral', 'trilinear']);
  const tetrahedral = { ...summarizeErrors(errors[0] as Float64Array), worst: worst[0] as Rgb };
  const trilinear = { ...summarizeErrors(errors[1] as Float64Array), worst: worst[1] as Rgb };
  return { tetrahedral, trilinear, pass: passesLimits(tetrahedral) };
}

export interface LutSizeChoice {
  /** 33, если он проходит проверку, иначе 65. */
  size: LutExportSize;
  checks: { 33: LutCheck; 65?: LutCheck };
}

/** Проверяет LUT 33; если он не проходит, проверяет и 65. Для диалога экспорта, в воркере. */
export function chooseLutSize(params: PipelineParams): LutSizeChoice {
  const baked = bakePipeline(params);
  const reference = (rgb: Rgb) => applyBaked(rgb, baked);
  const check33 = checkLut(bakeLut(params, 33), reference);
  if (check33.pass) return { size: 33, checks: { 33: check33 } };
  return { size: 65, checks: { 33: check33, 65: checkLut(bakeLut(params, 65), reference) } };
}
