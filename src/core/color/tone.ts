// Тональная кривая, шаг 4 конвейера. Модель — docs/decisions/0006-tone-curve.md.
import type { Adjust } from '../project/types';
import { luminance, type Rgb } from './srgb';
import { linearToSrgb, srgbToLinear } from './transfer';

export type ToneSliders = Pick<Adjust, 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>;

/**
 * Множители звеньев в порядке применения: контраст, света, тени, белые, чёрные.
 * Уже включают силу ползунка и нормировку φ, шейдер получает их как есть.
 */
export type ToneCoefficients = readonly [number, number, number, number, number];

/** Пик xᵃ(1−x)ᵇ, по нему φ нормируется на 1. */
const peak = (a: number, b: number) => (Math.pow(a, a) * Math.pow(b, b)) / Math.pow(a + b, a + b);

const CONTRAST = 0.8; // наклон на концах 1 ∓ 0.8
const HIGHLIGHTS = 0.12 / peak(6, 2); // сдвиг пика в 0.75
const SHADOWS = 0.12 / peak(2, 6); // сдвиг пика в 0.25
// Белые и чёрные заданы наклоном на конце, φ не нормируется: у x⁷(1−x) φ'(1) = −1,
// поэтому наклон в 1 равен 1 ∓ 0.9, а пик в 0.875 сдвигается на 0.9 · 0.049 ≈ 0.044.
// Чёрные — зеркально: x(1−x)⁷, наклон в 0 равен 1 ± 0.9.
const WHITES = 0.9;
const BLACKS = 0.9;

/** null — все пять ползунков нулевые, шаг пропускается. */
export function toneCoefficients(s: ToneSliders): ToneCoefficients | null {
  if (s.contrast === 0 && s.highlights === 0 && s.shadows === 0 && s.whites === 0 && s.blacks === 0) return null;
  return [
    (CONTRAST * s.contrast) / 100,
    (HIGHLIGHTS * s.highlights) / 100,
    (SHADOWS * s.shadows) / 100,
    (WHITES * s.whites) / 100,
    (BLACKS * s.blacks) / 100,
  ];
}

/** Кривая на шкале sRGB-кодированной яркости, [0, 1] → [0, 1]. */
export function toneCurve(x0: number, k: ToneCoefficients): number {
  let x = x0;
  let y = 1 - x;
  x += k[0] * x * y * (2 * x - 1);
  y = 1 - x;
  x += k[1] * pow6(x) * y * y;
  y = 1 - x;
  x += k[2] * x * x * pow6(y);
  y = 1 - x;
  x += k[3] * pow6(x) * x * y;
  y = 1 - x;
  x += k[4] * x * pow6(y) * y;
  return x;
}

function pow6(v: number): number {
  const v2 = v * v;
  return v2 * v2 * v2;
}

/** Нижняя граница делителя: чёрный пиксель остаётся чёрным при любом коэффициенте. */
export const TONE_MIN_Y = 1e-7;

/** Применяет кривую к яркости пикселя линейного sRGB, сохраняя соотношение каналов. */
export function applyTone(rgb: Rgb, k: ToneCoefficients): Rgb {
  const y = luminance(rgb);
  if (y >= 1) return [rgb[0], rgb[1], rgb[2]];
  const yc = Math.max(y, TONE_MIN_Y);
  let gain = srgbToLinear(toneCurve(linearToSrgb(yc), k)) / yc;
  if (gain > 1) {
    // Потолок охвата: осветление останавливается, когда самый яркий канал дошёл до 1.
    const top = Math.max(rgb[0], rgb[1], rgb[2]);
    if (top > 0) gain = Math.min(gain, Math.max(1, 1 / top));
  }
  return [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];
}
