// Передаточная функция sRGB (IEC 61966-2-1). Шаги 1 и 5 конвейера.
import type { Rgb } from './srgb';

/** Гамма-кодированное значение sRGB → линейный свет. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Линейный свет → гамма-кодированное значение sRGB. Для v > 1 продолжает степенную ветвь. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function decodeSrgb(rgb: Rgb): Rgb {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

export function encodeSrgb(rgb: Rgb): Rgb {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}

/** Срез в 0..1 и кодирование. Концы точные: 1.055 − 0.055 в double не равно 1. */
export function encodeSrgbClamped(rgb: Rgb): Rgb {
  return [encodeClamped(rgb[0]), encodeClamped(rgb[1]), encodeClamped(rgb[2])];
}

function encodeClamped(v: number): number {
  return v >= 1 ? 1 : v <= 0 ? 0 : linearToSrgb(v);
}
