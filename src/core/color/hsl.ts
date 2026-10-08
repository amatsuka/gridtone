// HSL по 8 диапазонам тона в OKLCH, шаг 7 конвейера.
// Параметры диапазонов смешиваются по тону и запекаются в таблицу по кругу (1D-текстура в шейдере).
import { HUE_BANDS } from '../project/defaults';
import type { Adjust, HueBand } from '../project/types';
import { sampleHueTable, smoothstep } from './math';
import type { Lch } from './srgb';

/**
 * Центры диапазонов — тона OKLCH. Красный, жёлтый, зелёный, голубой, синий и пурпурный — тона
 * основных цветов sRGB; оранжевый сдвинут к 60°, чтобы телесные тона (43–76°) попадали в него.
 */
export const HUE_BAND_CENTERS: Record<HueBand, number> = {
  red: 29,
  orange: 60,
  yellow: 110,
  green: 142,
  aqua: 195,
  blue: 264,
  purple: 294,
  magenta: 328,
};

/** Ползунок тона ±100 сдвигает тон на ±30°. */
export const HSL_HUE_SHIFT = 30;
/** Ползунок светлоты ±100 умножает L на 1 ± 0.3. */
export const HSL_LUM_SCALE = 0.3;
/** Ниже этой хромы действие HSL плавно гаснет: у почти серого тон — шум. */
export const HSL_CHROMA_FADE = 0.05;
/** Узлов таблицы на круге — по одному на градус. */
export const HSL_TABLE_SIZE = 360;

const CENTERS = HUE_BANDS.map((band) => HUE_BAND_CENTERS[band]);

/** Отрезок круга между соседними центрами, в котором лежит тон: индексы диапазонов и вес второго. */
function bandSegment(hue: number): { i: number; j: number; t: number } | null {
  const h = ((hue % 360) + 360) % 360;
  for (let i = 0; i < CENTERS.length; i++) {
    const from = CENTERS[i] as number;
    const j = (i + 1) % CENTERS.length;
    const span = ((CENTERS[j] as number) - from + 360) % 360;
    const offset = (h - from + 360) % 360;
    if (offset < span) return { i, j, t: smoothstep(0, 1, offset / span) };
  }
  // Отрезки покрывают весь круг: сюда попадает только NaN.
  return null;
}

/** Вес каждого диапазона для тона, в порядке HUE_BANDS. Веса двух соседних центров, в сумме 1. */
export function hueBandWeights(hue: number): number[] {
  const weights = new Array<number>(CENTERS.length).fill(0);
  const segment = bandSegment(hue);
  if (segment) {
    weights[segment.i] = 1 - segment.t;
    weights[segment.j] = segment.t;
  }
  return weights;
}

/**
 * Два соседних диапазона, между центрами которых лежит тон, и вес второго. Одно значение тона у обоих
 * сдвигает такой тон ровно на HSL_HUE_SHIFT · значение / 100: веса в сумме 1 (поправка тона, ADR 0021).
 */
export function hueBandPair(hue: number): { bands: [HueBand, HueBand]; weight: number } {
  const { i, j, t } = bandSegment(hue) ?? { i: 0, j: 1, t: 0 };
  return { bands: [HUE_BANDS[i] as HueBand, HUE_BANDS[j] as HueBand], weight: t };
}

/** Как сильно HSL действует на цвет с хромой C. */
export function chromaFade(C: number): number {
  return smoothstep(0, HSL_CHROMA_FADE, C);
}

/**
 * Таблица по кругу: в узле k (тон k°) — сдвиг тона в градусах, (множитель хромы − 1), (множитель L − 1).
 * Четвёртый канал не используется: RGBA удобнее для текстуры. null — все диапазоны нейтральны.
 */
export function bakeHslTable(hsl: Adjust['hsl']): Float32Array | null {
  const bands = HUE_BANDS.map((band) => hsl[band]);
  if (bands.every((b) => b.hue === 0 && b.sat === 0 && b.lum === 0)) return null;
  const table = new Float32Array(HSL_TABLE_SIZE * 4);
  for (let k = 0; k < HSL_TABLE_SIZE; k++) {
    const weights = hueBandWeights((k * 360) / HSL_TABLE_SIZE);
    let hue = 0;
    let sat = 0;
    let lum = 0;
    bands.forEach((band, i) => {
      const w = weights[i] as number;
      hue += (w * band.hue) / 100;
      sat += (w * band.sat) / 100;
      lum += (w * band.lum) / 100;
    });
    table[k * 4] = hue * HSL_HUE_SHIFT;
    table[k * 4 + 1] = sat;
    table[k * 4 + 2] = lum * HSL_LUM_SCALE;
  }
  return table;
}

export function applyHsl(lch: Lch, table: Float32Array): Lch {
  const [L, C, h] = lch;
  const fade = chromaFade(C);
  if (fade === 0) return [L, C, h];
  const dh = sampleHueTable(table, HSL_TABLE_SIZE, 4, 0, h);
  const ds = sampleHueTable(table, HSL_TABLE_SIZE, 4, 1, h);
  const dl = sampleHueTable(table, HSL_TABLE_SIZE, 4, 2, h);
  const hue = h + dh * fade;
  return [L * (1 + dl * fade), C * (1 + ds * fade), ((hue % 360) + 360) % 360];
}
