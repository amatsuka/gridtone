// Подготовка параметров коррекции: одна и та же для эталона на CPU и для шейдера.
// Всё, что зависит только от ползунков (коэффициенты, таблицы), считается здесь один раз,
// а не в каждом пикселе. Шаг, равный тождеству, получает null и пропускается целиком.
import type { Lut3D } from '../lut/lut3d';
import type { Adjust } from '../project/types';
import { bakeGrading, type BakedGrading } from './grading';
import { bakeHslTable } from './hsl';
import { isIdentityCurve, monotoneSpline } from './spline';
import type { Rgb } from './srgb';
import { toneCoefficients, type ToneCoefficients } from './tone';
import { whiteBalanceGains } from './whiteBalance';

/** Узлов в таблице кривых: x = i / (n − 1). */
export const CURVE_TABLE_SIZE = 1024;

/** Шаги 1–5: в линейном sRGB. */
export interface BakedLinear {
  wb: Rgb;
  /** 2^EV. */
  exposure: number;
  tone: ToneCoefficients | null;
}

/** Шаги 7–8: в OKLab/OKLCH. */
export interface BakedColor {
  /** bakeHslTable: HSL_TABLE_SIZE узлов по 4 канала. */
  hsl: Float32Array | null;
  grading: BakedGrading | null;
  /** Значения ползунков, делённые на 100. */
  vibrance: number;
  saturation: number;
}

export interface BakedAdjust {
  linear: BakedLinear | null;
  /** Шаг 6: CURVE_TABLE_SIZE узлов по 4 канала (R, G, B, не используется); общая кривая уже внутри. */
  curves: Float32Array | null;
  color: BakedColor | null;
}

export interface PipelineParams {
  /** Поправка фото — первый проход. */
  photo: Adjust;
  /** Образ — второй проход поверх первого. */
  look?: Adjust | undefined;
  /** Шаг 9: импортированный LUT образа, последний в его проходе (docs/decisions/0015-lut-import.md). */
  lut?: Lut3D | undefined;
}

export interface BakedPipeline {
  photo: BakedAdjust;
  look: BakedAdjust | null;
  /** LUT готов к выборке как есть: таблица уже в Lut3D. */
  lut: Lut3D | null;
}

export function bakeAdjust(adjust: Adjust): BakedAdjust {
  return { linear: bakeLinear(adjust), curves: bakeCurves(adjust.curves), color: bakeColor(adjust) };
}

export function bakePipeline({ photo, look, lut }: PipelineParams): BakedPipeline {
  return { photo: bakeAdjust(photo), look: look ? bakeAdjust(look) : null, lut: lut ?? null };
}

function bakeLinear(adjust: Adjust): BakedLinear | null {
  const tone = toneCoefficients(adjust);
  if (adjust.temp === 0 && adjust.tint === 0 && adjust.exposure === 0 && tone === null) return null;
  return { wb: whiteBalanceGains(adjust.temp, adjust.tint), exposure: Math.pow(2, adjust.exposure), tone };
}

function bakeCurves(curves: Adjust['curves']): Float32Array | null {
  const { master, r, g, b } = curves;
  if ([master, r, g, b].every(isIdentityCurve)) return null;
  const m = monotoneSpline(master);
  const channels = [r, g, b].map((points) => (isIdentityCurve(points) ? null : monotoneSpline(points)));
  const table = new Float32Array(CURVE_TABLE_SIZE * 4);
  for (let i = 0; i < CURVE_TABLE_SIZE; i++) {
    const x = m(i / (CURVE_TABLE_SIZE - 1));
    channels.forEach((f, c) => {
      table[i * 4 + c] = f ? f(x) : x;
    });
    table[i * 4 + 3] = 1;
  }
  return table;
}

function bakeColor(adjust: Adjust): BakedColor | null {
  const hsl = bakeHslTable(adjust.hsl);
  const grading = bakeGrading(adjust.grading);
  if (hsl === null && grading === null && adjust.vibrance === 0 && adjust.saturation === 0) return null;
  return { hsl, grading, vibrance: adjust.vibrance / 100, saturation: adjust.saturation / 100 };
}
