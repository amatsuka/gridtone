import { describe, expect, it } from 'vitest';
import { applyGrading, bakeGrading, gradingWeights } from '@core/color/grading';
import { oklabToOklch } from '@core/color/oklab';
import { createAdjust } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';

function grading(patch: Partial<Adjust['grading']>): Adjust['grading'] {
  return { ...createAdjust().grading, ...patch };
}

describe('цветокоррекция по трём кругам', () => {
  it('веса теней, средних и светов неотрицательны и в сумме дают 1', () => {
    for (const balance of [-100, -30, 0, 50, 100]) {
      const baked = bakeGrading(grading({ balance, shadows: { hue: 0, amount: 10 } }));
      if (!baked) throw new Error('ожидалась ненейтральная коррекция');
      for (let i = 0; i <= 100; i++) {
        const w = gradingWeights(i / 100, baked.exponent);
        for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
        expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 12);
      }
    }
  });

  it('тени преобладают в тёмном, света — в светлом, средние — посередине', () => {
    const [s1, m1, h1] = gradingWeights(0.1, 1);
    expect(s1).toBeGreaterThan(Math.max(m1, h1));
    const [s2, m2, h2] = gradingWeights(0.5, 1);
    expect(m2).toBeGreaterThan(Math.max(s2, h2));
    const [s3, m3, h3] = gradingWeights(0.9, 1);
    expect(h3).toBeGreaterThan(Math.max(s3, m3));
  });

  it('баланс в плюс отдаёт больше тонов светам', () => {
    const plus = bakeGrading(grading({ balance: 100, highlights: { hue: 0, amount: 10 } }));
    const minus = bakeGrading(grading({ balance: -100, highlights: { hue: 0, amount: 10 } }));
    if (!plus || !minus) throw new Error('ожидалась ненейтральная коррекция');
    expect(gradingWeights(0.5, plus.exponent)[2]).toBeGreaterThan(gradingWeights(0.5, 1)[2]);
    expect(gradingWeights(0.5, minus.exponent)[2]).toBeLessThan(gradingWeights(0.5, 1)[2]);
  });

  it('нулевые круги — коррекции нет, даже при ненулевом балансе', () => {
    expect(bakeGrading(createAdjust().grading)).toBeNull();
    expect(bakeGrading(grading({ balance: 40 }))).toBeNull();
  });

  it('тон круга задаёт направление сдвига, сила — его величину', () => {
    const baked = bakeGrading(grading({ shadows: { hue: 260, amount: 100 } }));
    if (!baked) throw new Error('ожидалась ненейтральная коррекция');
    const dark = applyGrading([0.15, 0, 0], baked);
    const [, C, h] = oklabToOklch(dark);
    expect(h).toBeCloseTo(260, 6);
    expect(C).toBeGreaterThan(0.04);
    expect(dark[0]).toBe(0.15);
    // Светлое тени почти не трогают.
    const [, cLight] = oklabToOklch(applyGrading([0.95, 0, 0], baked));
    expect(cLight).toBeLessThan(0.002);
  });

  it('сила 50 даёт вдвое меньший сдвиг, чем 100', () => {
    const full = bakeGrading(grading({ midtones: { hue: 60, amount: 100 } }));
    const half = bakeGrading(grading({ midtones: { hue: 60, amount: 50 } }));
    if (!full || !half) throw new Error('ожидалась ненейтральная коррекция');
    const cFull = oklabToOklch(applyGrading([0.5, 0, 0], full))[1];
    const cHalf = oklabToOklch(applyGrading([0.5, 0, 0], half))[1];
    expect(cHalf / cFull).toBeCloseTo(0.5, 12);
  });
});
