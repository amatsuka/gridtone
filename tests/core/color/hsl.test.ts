import { describe, expect, it } from 'vitest';
import { applyHsl, bakeHslTable, HSL_HUE_SHIFT, HUE_BAND_CENTERS, hueBandPair, hueBandWeights } from '@core/color/hsl';
import type { Lch } from '@core/color/srgb';
import { createAdjust, HUE_BANDS } from '@core/project/defaults';
import type { Adjust, HueBand } from '@core/project/types';

function hslWith(band: HueBand, values: Partial<Adjust['hsl'][HueBand]>): Adjust['hsl'] {
  const hsl = createAdjust().hsl;
  hsl[band] = { ...hsl[band], ...values };
  return hsl;
}

function apply(lch: Lch, hsl: Adjust['hsl']): Lch {
  const table = bakeHslTable(hsl);
  if (!table) throw new Error('ожидалась ненейтральная таблица');
  return applyHsl(lch, table);
}

const hueDistance = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('HSL по 8 диапазонам в OKLCH', () => {
  it('веса неотрицательны и в сумме дают 1 на всём круге', () => {
    for (let h = 0; h < 360; h += 0.25) {
      const weights = hueBandWeights(h);
      expect(weights).toHaveLength(8);
      for (const w of weights) expect(w).toBeGreaterThanOrEqual(0);
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });

  it('в центре диапазона его вес равен 1, а за соседними центрами — 0', () => {
    HUE_BANDS.forEach((band, i) => {
      const center = HUE_BAND_CENTERS[band];
      expect(hueBandWeights(center)[i]).toBeCloseTo(1, 12);
      const prev = HUE_BAND_CENTERS[HUE_BANDS[(i + 7) % 8] as HueBand];
      const next = HUE_BAND_CENTERS[HUE_BANDS[(i + 1) % 8] as HueBand];
      for (let h = 0; h < 360; h += 1) {
        const inside = hueDistance(h, center) <= Math.max(hueDistance(prev, center), hueDistance(next, center));
        if (!inside) expect(hueBandWeights(h)[i]).toBe(0);
      }
    });
  });

  it('два диапазона вокруг тона: одно значение обоим сдвигает тон ровно на 30° · v / 100', () => {
    expect(hueBandPair(232)).toEqual({ bands: ['aqua', 'blue'], weight: expect.closeTo(0.57, 1) });
    expect(hueBandPair(10).bands).toEqual(['magenta', 'red']);
    expect(hueBandPair(HUE_BAND_CENTERS.green).bands).toEqual(['green', 'aqua']);
    for (const h of [200, 232, 260]) {
      const hsl = createAdjust().hsl;
      for (const band of hueBandPair(h).bands) hsl[band] = { hue: -50, sat: 0, lum: 0 };
      expect(hueDistance(apply([0.6, 0.1, h], hsl)[2], h - HSL_HUE_SHIFT * 0.5)).toBeLessThan(1e-4);
    }
  });

  it('нейтральные значения — таблицы нет', () => {
    expect(bakeHslTable(createAdjust().hsl)).toBeNull();
  });

  it('насыщенность −100 у красных обесцвечивает красный и не трогает синий', () => {
    const hsl = hslWith('red', { sat: -100 });
    expect(apply([0.63, 0.25, HUE_BAND_CENTERS.red], hsl)[1]).toBeCloseTo(0, 6);
    expect(apply([0.45, 0.3, HUE_BAND_CENTERS.blue], hsl)).toEqual([0.45, 0.3, HUE_BAND_CENTERS.blue]);
  });

  it('тон +100 у оранжевых сдвигает оранжевый к жёлтому на 30°', () => {
    const [, , h] = apply([0.7, 0.15, HUE_BAND_CENTERS.orange], hslWith('orange', { hue: 100 }));
    expect(h).toBeCloseTo(HUE_BAND_CENTERS.orange + 30, 6);
  });

  it('светлота −100 у синих затемняет синий и не трогает красный', () => {
    const hsl = hslWith('blue', { lum: -100 });
    expect(apply([0.6, 0.12, HUE_BAND_CENTERS.blue], hsl)[0]).toBeLessThan(0.45);
    expect(apply([0.63, 0.25, HUE_BAND_CENTERS.red], hsl)[0]).toBe(0.63);
  });

  it('серые не меняются ни от каких настроек', () => {
    const hsl = createAdjust().hsl;
    for (const band of HUE_BANDS) hsl[band] = { hue: 100, sat: 100, lum: -100 };
    for (let h = 0; h < 360; h += 15) expect(apply([0.5, 0, h], hsl)).toEqual([0.5, 0, h]);
  });

  it('таблица между узлами повторяет веса диапазонов', () => {
    const hsl = hslWith('green', { hue: 40, sat: -50, lum: 30 });
    hsl.aqua = { hue: -20, sat: 60, lum: 0 };
    const table = bakeHslTable(hsl);
    if (!table) throw new Error('ожидалась ненейтральная таблица');
    for (const h of [150.5, 170.25, 188.75]) {
      const w = hueBandWeights(h);
      const iGreen = HUE_BANDS.indexOf('green');
      const iAqua = HUE_BANDS.indexOf('aqua');
      const expectedSatFactor = 1 + (w[iGreen] ?? 0) * -0.5 + (w[iAqua] ?? 0) * 0.6;
      const [, C] = applyHsl([0.6, 0.2, h], table);
      expect(C / 0.2).toBeCloseTo(expectedSatFactor, 2);
    }
  });
});
