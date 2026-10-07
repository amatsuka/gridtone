import { describe, expect, it } from 'vitest';
import { decodeSrgb, encodeSrgb, linearToSrgb, srgbToLinear } from '@core/color/transfer';

describe('sRGB ↔ линейный', () => {
  it('совпадает с опорными значениями IEC 61966-2-1', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 8);
    expect(srgbToLinear(128 / 255)).toBeCloseTo(0.2158605, 7);
    expect(linearToSrgb(0.18)).toBeCloseTo(0.46135613, 8);
    expect(linearToSrgb(0.5)).toBeCloseTo(0.73535698, 8);
    // Линейный участок у чёрного.
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 15);
    expect(linearToSrgb(0.001)).toBeCloseTo(0.01292, 15);
  });

  it('туда и обратно возвращает исходное значение', () => {
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 12);
    }
  });

  it('непрерывна на стыке ветвей и строго возрастает', () => {
    expect(Math.abs(srgbToLinear(0.04045 + 1e-9) - srgbToLinear(0.04045 - 1e-9))).toBeLessThan(1e-7);
    expect(Math.abs(linearToSrgb(0.0031308 + 1e-10) - linearToSrgb(0.0031308 - 1e-10))).toBeLessThan(1e-7);
    let prevDecoded = -1;
    let prevEncoded = -1;
    for (let i = 0; i <= 4096; i++) {
      const v = i / 4096;
      expect(srgbToLinear(v)).toBeGreaterThan(prevDecoded);
      expect(linearToSrgb(v)).toBeGreaterThan(prevEncoded);
      prevDecoded = srgbToLinear(v);
      prevEncoded = linearToSrgb(v);
    }
  });

  it('векторные версии применяют функцию к каждому каналу', () => {
    expect(decodeSrgb([0, 0.5, 1])).toEqual([0, srgbToLinear(0.5), srgbToLinear(1)]);
    expect(encodeSrgb([0, 0.18, 1])).toEqual([0, linearToSrgb(0.18), linearToSrgb(1)]);
  });
});
