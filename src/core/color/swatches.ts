// Образцы цвета для панелей коррекции: картинка круга цветокоррекции, его геометрия и дорожки
// ползунков HSL. Цвета — в OKLCH, в тех же тонах, что и шаг 7 конвейера (hsl.ts, grading.ts).
import type { HueBand } from '../project/types';
import { HSL_HUE_SHIFT, HSL_LUM_SCALE, HUE_BAND_CENTERS } from './hsl';
import { oklabToLinearSrgb, oklchToOklab } from './oklab';
import type { Rgb } from './srgb';
import { encodeSrgbClamped } from './transfer';

/** Светлота круга и хрома на его краю. Хрома для наглядности больше, чем реальный сдвиг круга. */
export const WHEEL_PREVIEW_L = 0.72;
export const WHEEL_PREVIEW_CHROMA = 0.14;

export type HslProperty = 'hue' | 'sat' | 'lum';

/** OKLCH → sRGB 0..1. Цвет вне охвата теряет хрому, а не тон: срез по каналам сдвинул бы тон образца. */
function lchToSrgb(L: number, C: number, h: number): Rgb {
  const linear = (chroma: number) => oklabToLinearSrgb(oklchToOklab([L, chroma, h]));
  const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-9 && v <= 1 + 1e-9);
  let rgb = linear(C);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linear(mid))) lo = mid;
      else hi = mid;
    }
    rgb = linear(lo);
  }
  return encodeSrgbClamped(rgb);
}

/**
 * Точка на круге (x вправо, y вниз, радиус 1) → тон и сила круга. Тон в OKLab: 0° — вправо,
 * растёт против часовой стрелки; сила — расстояние от центра, за краем 100. Оба целые.
 */
export function wheelFromPoint(x: number, y: number): { hue: number; amount: number } {
  const amount = Math.round(Math.min(1, Math.hypot(x, y)) * 100);
  if (amount === 0) return { hue: 0, amount: 0 };
  const deg = (Math.atan2(-y, x) * 180) / Math.PI;
  const hue = Math.round(deg < 0 ? deg + 360 : deg) % 360;
  // atan2(−0, x) = −0: в проект должен попасть обычный 0.
  return { hue: hue === 0 ? 0 : hue, amount };
}

/** Обратно: тон и сила → точка на круге радиуса 1, y вниз. */
export function wheelToPoint(hue: number, amount: number): [number, number] {
  const rad = (hue * Math.PI) / 180;
  const r = amount / 100;
  return [r * Math.cos(rad), -r * Math.sin(rad)];
}

/** Картинка круга RGBA 8 бит size × size: серый в центре, хрома растёт к краю, край сглажен. */
export function wheelImage(size: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = ((py + 0.5) / size) * 2 - 1;
      const r = Math.hypot(x, y);
      const alpha = Math.min(1, Math.max(0, (1 - r) * (size / 2) + 0.5));
      if (alpha === 0) continue;
      const deg = (Math.atan2(-y, x) * 180) / Math.PI;
      const rgb = lchToSrgb(WHEEL_PREVIEW_L, Math.min(1, r) * WHEEL_PREVIEW_CHROMA, deg < 0 ? deg + 360 : deg);
      const i = (py * size + px) * 4;
      data[i] = Math.round(rgb[0] * 255);
      data[i + 1] = Math.round(rgb[1] * 255);
      data[i + 2] = Math.round(rgb[2] * 255);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return data;
}

// Опорный цвет диапазона для дорожек: средняя светлота, умеренная хрома.
const TRACK_L = 0.7;
const TRACK_CHROMA = 0.1;

/**
 * Цвета дорожки ползунка HSL от −100 до +100, stops точек: что ползунок делает с цветом диапазона.
 * Тон — центр ± HSL_HUE_SHIFT; насыщенность — от серого до удвоенной хромы; яркость — L·(1 ± HSL_LUM_SCALE).
 */
export function hslTrack(band: HueBand, property: HslProperty, stops = 7): Rgb[] {
  const center = HUE_BAND_CENTERS[band];
  return Array.from({ length: stops }, (_, i) => {
    const s = (i / (stops - 1)) * 2 - 1;
    if (property === 'hue') return lchToSrgb(TRACK_L, TRACK_CHROMA, center + s * HSL_HUE_SHIFT);
    if (property === 'sat') return lchToSrgb(TRACK_L, TRACK_CHROMA * (1 + s), center);
    return lchToSrgb(TRACK_L * (1 + s * HSL_LUM_SCALE), TRACK_CHROMA, center);
  });
}
