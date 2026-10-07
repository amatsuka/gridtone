// Сочность и насыщенность — масштаб хромы в OKLCH, шаг 8 конвейера.
// Сочность слабее действует на уже насыщенные цвета и на телесные тона.
import { hueDistance, smoothstep } from './math';
import type { Lch } from './srgb';

/** От этой хромы сочность не действует совсем. */
export const VIBRANCE_CHROMA_LIMIT = 0.25;
/** Центр телесных тонов в OKLCH: у кожи от светлой до тёмной тон 43–76°. */
export const SKIN_HUE = 60;
/** Ширина гауссианы телесных тонов, градусы. */
export const SKIN_WIDTH = 20;
/** Доля, на которую сочность ослаблена в центре телесных тонов. */
export const SKIN_PROTECTION = 0.6;

/** Вес сочности для цвета: 1 у серого, 0 у насыщенного, меньше у кожи. */
export function vibranceWeight(C: number, hue: number): number {
  const d = hueDistance(hue, SKIN_HUE) / SKIN_WIDTH;
  return (1 - smoothstep(0, VIBRANCE_CHROMA_LIMIT, C)) * (1 - SKIN_PROTECTION * Math.exp(-d * d));
}

/** vibrance и saturation — значения ползунков, делённые на 100. */
export function applyChroma(lch: Lch, vibrance: number, saturation: number): Lch {
  const [L, C, h] = lch;
  const vib = vibrance === 0 ? 1 : 1 + vibrance * vibranceWeight(C, h);
  return [L, C * vib * (1 + saturation), h];
}
