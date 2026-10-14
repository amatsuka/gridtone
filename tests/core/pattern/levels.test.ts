import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LEVELS,
  HARD_TOLERANCE,
  hardTarget,
  levelL,
  SOFT_TOLERANCE,
  softTarget,
  targetColorFromAb,
} from '@core/pattern/levels';
import { NEUTRAL_CHROMA } from '@core/metrics/features';

describe('уровни L, M, D', () => {
  test('по умолчанию — 0.80, 0.62 и 0.44: середина 0.62, контраст 0.36', () => {
    expect(DEFAULT_LEVELS).toEqual({ center: 0.62, contrast: 0.36 });
    expect(levelL('L', DEFAULT_LEVELS)).toBe(0.8);
    expect(levelL('M', DEFAULT_LEVELS)).toBe(0.62);
    expect(levelL('D', DEFAULT_LEVELS)).toBe(0.44);
  });

  test('середина и контраст сдвигают и раздвигают уровни; L не выходит за 0..1', () => {
    expect(levelL('L', { center: 0.5, contrast: 0.2 })).toBe(0.6);
    expect(levelL('D', { center: 0.5, contrast: 0.2 })).toBe(0.4);
    expect(levelL('M', { center: 0.5, contrast: 0.2 })).toBe(0.5);
    expect(levelL('L', { center: 0.9, contrast: 0.6 })).toBe(1);
    expect(levelL('D', { center: 0.1, contrast: 0.6 })).toBe(0);
    // Нулевой контраст — все уровни на середине.
    expect(levelL('L', { center: 0.7, contrast: 0 })).toBe(0.7);
  });
});

describe('цели и допуски', () => {
  test('жёсткая цель — допуски L 0.06, тон 15°, хрома 0.02', () => {
    expect(HARD_TOLERANCE).toEqual({ L: 0.06, hue: 15, chroma: 0.02 });
    expect(hardTarget(0.8)).toEqual({ L: 0.8, tolerance: { L: 0.06, hue: 15, chroma: 0.02 }, hard: true });
    expect(hardTarget(0.44, { hue: 250, chroma: 0.05 })).toEqual({
      L: 0.44,
      hue: 250,
      chroma: 0.05,
      tolerance: HARD_TOLERANCE,
      hard: true,
    });
  });

  test('мягкая цель — допуски 0.10, 25° и 0.03', () => {
    expect(SOFT_TOLERANCE).toEqual({ L: 0.1, hue: 25, chroma: 0.03 });
    expect(softTarget(0.5, { chroma: 0.01 })).toEqual({ L: 0.5, chroma: 0.01, tolerance: SOFT_TOLERANCE, hard: false });
  });

  test('допуски у каждой цели свои: правка одной не меняет другую', () => {
    const a = hardTarget(0.5);
    a.tolerance.L = 1;
    expect(hardTarget(0.5).tolerance.L).toBe(0.06);
  });

  test('тон приводится к 0..360, числа округляются до 4 знаков', () => {
    expect(hardTarget(0.123456, { hue: -30, chroma: 0.0512345 })).toMatchObject({ L: 0.1235, hue: 330, chroma: 0.0512 });
    expect(hardTarget(0.5, { hue: 360, chroma: 0.05 }).hue).toBe(0);
  });

  test('цвет из (a, b): тон — только если хрома не меньше порога нейтральных', () => {
    expect(targetColorFromAb(0.05, 0)).toEqual({ hue: 0, chroma: 0.05 });
    expect(targetColorFromAb(0, -0.04)).toEqual({ hue: 270, chroma: 0.04 });
    const gray = targetColorFromAb(0.01, 0.01);
    expect(gray.hue).toBeUndefined();
    expect(gray.chroma).toBeCloseTo(Math.SQRT2 * 0.01, 4);
    expect(targetColorFromAb(NEUTRAL_CHROMA, 0).hue).toBe(0);
  });
});
