import { describe, expect, it } from 'vitest';
import { oklabToOklch } from '@core/color/oklab';
import { linearSrgbToOklab } from '@core/color/oklab';
import { decodeSrgb } from '@core/color/transfer';
import { deviation, deviationColor, DEVIATION_HUE_CHROMA } from '@core/metrics/deviation';
import type { LabStats } from '@core/metrics/palette';
import type { SlotTarget } from '@core/project/types';

function stats(meanL: number, meanC = 0, hue = 0): LabStats {
  const rad = (hue * Math.PI) / 180;
  return { meanL, meanA: meanC * Math.cos(rad), meanB: meanC * Math.sin(rad), meanC, hue };
}

function target(patch: Partial<SlotTarget> = {}): SlotTarget {
  return { L: 0.6, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true, ...patch };
}

const hueOf = (rgb: [number, number, number]) => oklabToOklch(linearSrgbToOklab(decodeSrgb(rgb)))[2];

describe('отклонение от цели', () => {
  it('в цели — 0, на краю допуска — 1, вдвое дальше — 2', () => {
    expect(deviation(stats(0.6), target())).toBe(0);
    expect(deviation(stats(0.65), target())).toBeCloseTo(1, 12);
    expect(deviation(stats(0.5), target())).toBeCloseTo(2, 12);
  });

  it('тон и хрома считаются, только если заданы в цели', () => {
    expect(deviation(stats(0.6, 0.2, 180), target())).toBe(0);
    expect(deviation(stats(0.6, 0.2, 180), target({ hue: 160 }))).toBeCloseTo(1, 12);
    expect(deviation(stats(0.6, 0.2, 180), target({ chroma: 0.12 }))).toBeCloseTo(2, 12);
  });

  it('берётся худшая из частей', () => {
    const t = target({ hue: 30, chroma: 0.1 });
    expect(deviation(stats(0.62, 0.1, 70), t)).toBeCloseTo(2, 12);
    expect(deviation(stats(0.75, 0.1, 30), t)).toBeCloseTo(3, 12);
  });

  it('тон почти серой плитки почти не важен', () => {
    const t = target({ hue: 30 });
    const gray = deviation(stats(0.6, DEVIATION_HUE_CHROMA / 10, 210), t);
    const colorful = deviation(stats(0.6, DEVIATION_HUE_CHROMA, 210), t);
    expect(gray).toBeCloseTo(colorful / 10, 12);
    expect(colorful).toBeCloseTo(180 / 20, 12);
  });

  it('нулевой допуск: точное попадание — 0, промах — бесконечность', () => {
    const t = target({ tolerance: { L: 0, hue: 0, chroma: 0 } });
    expect(deviation(stats(0.6), t)).toBe(0);
    expect(deviation(stats(0.61), t)).toBe(Infinity);
  });
});

describe('шкала отклонения', () => {
  it('0 — зелёный, 1 — жёлтый, от 2 — красный', () => {
    const green = hueOf(deviationColor(0));
    const yellow = hueOf(deviationColor(1));
    const red = hueOf(deviationColor(2));
    expect(green).toBeGreaterThan(125);
    expect(green).toBeLessThan(160);
    expect(yellow).toBeGreaterThan(85);
    expect(yellow).toBeLessThan(115);
    expect(red < 45 || red > 345).toBe(true);
    expect(deviationColor(5)).toEqual(deviationColor(2));
    expect(deviationColor(Infinity)).toEqual(deviationColor(2));
    expect(deviationColor(-1)).toEqual(deviationColor(0));
  });

  it('тон меняется монотонно от зелёного к красному', () => {
    let prev = hueOf(deviationColor(0));
    for (let d = 0.1; d <= 2; d += 0.1) {
      const h = hueOf(deviationColor(d));
      expect(h).toBeLessThanOrEqual(prev + 1e-9);
      prev = h;
    }
  });

  it('цвета в охвате sRGB', () => {
    for (let d = 0; d <= 2; d += 0.05) for (const v of deviationColor(d)) expect(v >= 0 && v <= 1).toBe(true);
  });
});
