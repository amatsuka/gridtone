// Стоимость попадания фото в цель позиции (ADR 0025): формула модуля 5 без палитры и штрафов.
import { describe, expect, it } from 'vitest';
import { COST_PART_MAX, costParts, costStats, targetCost } from '@core/match/cost';
import { deviation, DEVIATION_HUE_CHROMA } from '@core/metrics/deviation';
import type { SlotTarget } from '@core/project/types';

/** Средние плитки: L, средняя хрома пикселей и тон среднего. */
const stats = (meanL: number, meanC = 0, hue = 0) => ({ meanL, meanC, hue });

function target(patch: Partial<SlotTarget> = {}): SlotTarget {
  return { L: 0.6, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true, ...patch };
}

describe('стоимость попадания в цель', () => {
  it('в цели — 0', () => {
    expect(targetCost(stats(0.6), target())).toBe(0);
    expect(targetCost(stats(0.6, 0.1, 30), target({ hue: 30, chroma: 0.1 }))).toBe(0);
  });

  it('линейна по каждой части: доля допуска, вдвое дальше — вдвое дороже', () => {
    expect(targetCost(stats(0.65), target())).toBeCloseTo(1, 12);
    expect(targetCost(stats(0.5), target())).toBeCloseTo(2, 12);
    expect(targetCost(stats(0.6, 0.14), target({ chroma: 0.1 }))).toBeCloseTo(1, 12);
    expect(targetCost(stats(0.6, 0.18), target({ chroma: 0.1 }))).toBeCloseTo(2, 12);
    expect(targetCost(stats(0.6, 0.1, 50), target({ hue: 30 }))).toBeCloseTo(1, 12);
    expect(targetCost(stats(0.6, 0.1, 70), target({ hue: 30 }))).toBeCloseTo(2, 12);
  });

  it('части складываются, а не берётся худшая, как у отклонения', () => {
    const t = target({ hue: 30, chroma: 0.1 });
    const s = stats(0.65, 0.14, 70);
    expect(costParts(s, t)).toEqual({ L: expect.closeTo(1, 12), chroma: expect.closeTo(1, 12), hue: expect.closeTo(2, 12) });
    expect(targetCost(s, t)).toBeCloseTo(4, 12);
    expect(deviation(s, t)).toBeCloseTo(2, 12);
  });

  it('тон весит по хроме плитки — как у отклонения: у серой 0, от 0.05 — полностью', () => {
    const t = target({ hue: 30 });
    expect(targetCost(stats(0.6, 0, 210), t)).toBe(0);
    const gray = targetCost(stats(0.6, DEVIATION_HUE_CHROMA / 10, 210), t);
    const colorful = targetCost(stats(0.6, DEVIATION_HUE_CHROMA, 210), t);
    expect(colorful).toBeCloseTo(180 / 20, 12);
    expect(gray).toBeCloseTo(colorful / 10, 12);
    expect(targetCost(stats(0.6, 0.2, 210), t)).toBeCloseTo(colorful, 12);
  });

  it('тон и хрома — только у цели с цветом', () => {
    const colorful = stats(0.6, 0.2, 180);
    expect(costParts(colorful, target())).toEqual({ L: 0, hue: 0, chroma: 0 });
    expect(costParts(colorful, target({ chroma: 0.12 })).hue).toBe(0);
    expect(costParts(colorful, target({ hue: 160 })).chroma).toBe(0);
  });

  it('тон через 0°/360° — по кратчайшей дуге', () => {
    expect(targetCost(stats(0.6, 0.1, 350), target({ hue: 10 }))).toBeCloseTo(1, 12);
  });

  it('нулевой допуск: точное попадание — 0, промах — конечный потолок, чтобы назначение не ломалось', () => {
    const t = target({ hue: 30, chroma: 0.1, tolerance: { L: 0, hue: 0, chroma: 0 } });
    expect(targetCost(stats(0.6, 0.1, 30), t)).toBe(0);
    expect(costParts(stats(0.61, 0.1, 30), t).L).toBe(COST_PART_MAX);
    expect(targetCost(stats(0.61, 0.2, 40), t)).toBe(3 * COST_PART_MAX);
    expect(targetCost(stats(0.9), target({ tolerance: { L: 0.0001, hue: 15, chroma: 0.02 } }))).toBe(COST_PART_MAX);
  });

  it('средние из признаков: тон — угол среднего (a, b), хрома — средняя хрома пикселей', () => {
    const s = costStats({ meanL: 0.5, meanA: 0, meanB: 0.04, meanC: 0.07 });
    expect(s.meanL).toBe(0.5);
    expect(s.meanC).toBe(0.07);
    expect(s.hue).toBeCloseTo(90, 12);
  });
});
