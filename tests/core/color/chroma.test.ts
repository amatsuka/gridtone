import { describe, expect, it } from 'vitest';
import { applyChroma, SKIN_HUE, vibranceWeight } from '@core/color/chroma';
import type { Lch } from '@core/color/srgb';

describe('сочность и насыщенность', () => {
  it('нулевые значения — тождество', () => {
    const lch: Lch = [0.6, 0.12, 200];
    expect(applyChroma(lch, 0, 0)).toEqual(lch);
  });

  it('насыщенность масштабирует хрому одинаково для всех цветов, L и тон не меняются', () => {
    for (const lch of [
      [0.6, 0.02, 30],
      [0.5, 0.25, 264],
      [0.8, 0.1, SKIN_HUE],
    ] as Lch[]) {
      expect(applyChroma(lch, 0, -1)).toEqual([lch[0], 0, lch[2]]);
      const [L, C, h] = applyChroma(lch, 0, 1);
      expect(L).toBe(lch[0]);
      expect(h).toBe(lch[2]);
      expect(C).toBeCloseTo(lch[1] * 2, 12);
    }
  });

  it('сочность бережёт насыщенные цвета', () => {
    const muted = applyChroma([0.6, 0.04, 200], 1, 0)[1] / 0.04;
    const vivid = applyChroma([0.6, 0.22, 200], 1, 0)[1] / 0.22;
    expect(muted).toBeGreaterThan(1.7);
    expect(vivid).toBeLessThan(1.1);
    expect(vibranceWeight(0.3, 200)).toBe(0);
  });

  it('сочность бережёт телесные тона', () => {
    const skin = applyChroma([0.75, 0.08, SKIN_HUE], 1, 0)[1] / 0.08;
    const teal = applyChroma([0.75, 0.08, SKIN_HUE + 140], 1, 0)[1] / 0.08;
    expect(skin).toBeLessThan(teal);
    expect(skin - 1).toBeLessThan((teal - 1) * 0.5);
  });

  it('сочность −100 не делает хрому отрицательной', () => {
    for (let C = 0; C <= 0.35; C += 0.01) expect(applyChroma([0.5, C, 120], -1, 0)[1]).toBeGreaterThanOrEqual(0);
  });
});
