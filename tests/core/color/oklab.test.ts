import { describe, expect, it } from 'vitest';
import { linearSrgbToOklab, oklabToLinearSrgb, oklabToOklch, oklchToOklab, xyzToOklab } from '@core/color/oklab';
import { decodeSrgb } from '@core/color/transfer';
import type { Lab } from '@core/color/srgb';
import { randomColors } from './helpers';

function expectNear(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  actual.forEach((value, i) => expect(Math.abs(value - (expected[i] ?? NaN))).toBeLessThanOrEqual(tolerance));
}

describe('OKLab', () => {
  // Таблица из статьи Оттоссона «A perceptual color space for image processing» (2020): XYZ → OKLab.
  // Значения даны с тремя знаками, поэтому допуск 10⁻³.
  it.each([
    [[0.95, 1.0, 1.089], [1.0, 0.0, 0.0]],
    [[1.0, 0.0, 0.0], [0.45, 1.236, -0.019]],
    [[0.0, 1.0, 0.0], [0.922, -0.671, 0.263]],
    [[0.0, 0.0, 1.0], [0.153, -1.415, -0.449]],
  ] as const)('XYZ %j → OKLab %j по таблице Оттоссона', (xyz, lab) => {
    expectNear(xyzToOklab([...xyz]), lab, 1e-3);
  });

  it('красный sRGB совпадает с примером CSS Color 4: oklch(0.628 0.2577 29.23)', () => {
    const [L, C, h] = oklabToOklch(linearSrgbToOklab(decodeSrgb([1, 0, 0])));
    expect(L).toBeCloseTo(0.628, 3);
    expect(C).toBeCloseTo(0.2577, 3);
    expect(h).toBeCloseTo(29.23, 1);
  });

  it('белый — L = 1, серые — без цветности', () => {
    expectNear(linearSrgbToOklab([1, 1, 1]), [1, 0, 0], 1e-4);
    for (const v of [0.01, 0.18, 0.5, 0.9]) {
      const [, a, b] = linearSrgbToOklab([v, v, v]);
      expect(Math.hypot(a, b)).toBeLessThan(1e-4);
    }
    expect(linearSrgbToOklab([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('linear sRGB → OKLab → linear sRGB возвращает исходный цвет', () => {
    // Матрицы опубликованы с 10 знаками и взаимно обратны лишь до ~10⁻⁷.
    for (const rgb of randomColors(500, 1)) expectNear(oklabToLinearSrgb(linearSrgbToOklab(rgb)), rgb, 1e-6);
  });

  it('OKLCH: тон в градусах 0..360, обратный перевод точный', () => {
    for (const rgb of randomColors(500, 2)) {
      const lab = linearSrgbToOklab(rgb);
      const lch = oklabToOklch(lab);
      expect(lch[2]).toBeGreaterThanOrEqual(0);
      expect(lch[2]).toBeLessThan(360);
      expectNear(oklchToOklab(lch), lab, 1e-12);
    }
    const blue: Lab = linearSrgbToOklab([0, 0, 1]);
    expect(oklabToOklch(blue)[2]).toBeCloseTo(264.05, 1);
  });
});
