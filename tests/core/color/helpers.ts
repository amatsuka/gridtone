// Общие помощники тестов цвета: воспроизводимые случайные цвета без зависимостей.
import type { Rgb } from '@core/color/srgb';

/** Генератор mulberry32: одинаковая последовательность при одинаковом seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomColors(count: number, seed: number): Rgb[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => [random(), random(), random()] as Rgb);
}

/** Решётка n³ цветов от 0 до 1 включительно. */
export function colorLattice(n: number): Rgb[] {
  const colors: Rgb[] = [];
  for (let r = 0; r < n; r++)
    for (let g = 0; g < n; g++) for (let b = 0; b < n; b++) colors.push([r / (n - 1), g / (n - 1), b / (n - 1)]);
  return colors;
}
