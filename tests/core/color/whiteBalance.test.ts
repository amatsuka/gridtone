// Модель — docs/decisions/0007-white-balance.md.
import { describe, expect, it } from 'vitest';
import { LUMINANCE } from '@core/color/srgb';
import { MIRED_D65, planckianUv, whiteBalanceGains, whitePointUv } from '@core/color/whiteBalance';

/** xy → uv МКО 1960 — независимо от реализации, для опорных точек. */
function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

const distance = (p: readonly number[], q: readonly number[]) => Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0));
const lum = (g: readonly number[]) => LUMINANCE[0] * (g[0] ?? 0) + LUMINANCE[1] * (g[1] ?? 0) + LUMINANCE[2] * (g[2] ?? 0);
const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

describe('баланс белого', () => {
  it('локус Планка совпадает с источником A (2856 K)', () => {
    expect(distance(planckianUv(2856), xyToUv(0.44757, 0.40745))).toBeLessThan(2e-4);
  });

  it('D65 лежит на нормали к локусу в точке 6504 K при Duv ≈ +0.0032', () => {
    // Попадание проверяет и аппроксимацию, и знак нормали: плюс — над локусом, к зелёному.
    expect(distance(whitePointUv(MIRED_D65, 0.0032), xyToUv(0.31271, 0.32902))).toBeLessThan(2e-4);
  });

  it('нулевые ползунки дают коэффициенты ровно (1, 1, 1)', () => {
    expect(whiteBalanceGains(0, 0)).toEqual([1, 1, 1]);
  });

  it('яркость нейтрального серого сохраняется', () => {
    for (const temp of range(-100, 100, 10))
      for (const tint of range(-100, 100, 10)) expect(lum(whiteBalanceGains(temp, tint))).toBeCloseTo(lum([1, 1, 1]), 12);
  });

  it('температура в плюс теплее: R/B растёт по всему ходу', () => {
    let prev = 0;
    for (const temp of range(-100, 100, 2)) {
      const [r, , b] = whiteBalanceGains(temp, 0);
      expect(r / b).toBeGreaterThan(prev);
      prev = r / b;
    }
    const [r, , b] = whiteBalanceGains(30, 0);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });

  it('оттенок в плюс уводит к пурпурному: G падает', () => {
    let prev = Infinity;
    for (const tint of range(-100, 100, 2)) {
      const [, g] = whiteBalanceGains(0, tint);
      expect(g).toBeLessThan(prev);
      prev = g;
    }
  });

  it('коэффициенты положительны во всех углах', () => {
    for (const temp of [-100, 100]) for (const tint of [-100, 100]) for (const g of whiteBalanceGains(temp, tint)) expect(g).toBeGreaterThan(0.1);
  });

  it('сила совпадает с таблицей ADR 0007', () => {
    const cases: [number, number, [number, number, number]][] = [
      [10, 0, [1.034, 0.996, 0.939]],
      [100, 0, [1.374, 0.939, 0.503]],
      [-100, 0, [0.725, 1.005, 1.758]],
      [0, 100, [1.273, 0.895, 1.233]],
      [-100, -100, [0.394, 1.115, 1.644]],
    ];
    for (const [temp, tint, expected] of cases) {
      whiteBalanceGains(temp, tint).forEach((g, i) => expect(g).toBeCloseTo(expected[i] ?? NaN, 2));
    }
  });
});
