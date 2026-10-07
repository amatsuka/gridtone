import { describe, expect, it } from 'vitest';
import { monotoneSpline, sampleCurve } from '@core/color/spline';
import type { Pt } from '@core/project/types';

const dense = (n = 2000) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('сплайн Фрича — Карлсона', () => {
  it('две точки на диагонали дают тождество', () => {
    const f = monotoneSpline([
      [0, 0],
      [1, 1],
    ]);
    for (const x of dense()) expect(f(x)).toBeCloseTo(x, 14);
  });

  it('точки на прямой дают прямую', () => {
    const f = monotoneSpline([
      [0, 0.1],
      [0.3, 0.34],
      [0.7, 0.66],
      [1, 0.9],
    ]);
    for (const x of dense()) expect(f(x)).toBeCloseTo(0.1 + 0.8 * x, 12);
  });

  it('проходит через все точки', () => {
    const points: Pt[] = [
      [0, 0.05],
      [0.2, 0.1],
      [0.45, 0.6],
      [0.5, 0.62],
      [0.8, 0.7],
      [1, 1],
    ];
    const f = monotoneSpline(points);
    for (const [x, y] of points) expect(f(x)).toBeCloseTo(y, 14);
  });

  it('монотонные данные дают монотонную кривую', () => {
    const f = monotoneSpline([
      [0, 0],
      [0.1, 0.4],
      [0.15, 0.45],
      [0.6, 0.5],
      [0.62, 0.9],
      [1, 1],
    ]);
    let prev = -Infinity;
    for (const x of dense()) {
      expect(f(x)).toBeGreaterThanOrEqual(prev);
      prev = f(x);
    }
  });

  it('без выбросов: на каждом отрезке значение между значениями его концов', () => {
    const points: Pt[] = [
      [0, 0],
      [0.4, 0],
      [0.45, 1],
      [0.6, 0.2],
      [0.61, 0.9],
      [1, 1],
    ];
    const f = monotoneSpline(points);
    for (let k = 0; k + 1 < points.length; k++) {
      const [x0, y0] = points[k] as Pt;
      const [x1, y1] = points[k + 1] as Pt;
      for (let i = 0; i <= 200; i++) {
        const y = f(x0 + ((x1 - x0) * i) / 200);
        expect(y).toBeGreaterThanOrEqual(Math.min(y0, y1) - 1e-12);
        expect(y).toBeLessThanOrEqual(Math.max(y0, y1) + 1e-12);
      }
    }
    // Плоский участок остаётся плоским.
    for (const x of [0.05, 0.2, 0.39]) expect(f(x)).toBe(0);
  });

  it('гладкая: производная непрерывна в узлах', () => {
    const points: Pt[] = [
      [0, 0],
      [0.25, 0.4],
      [0.5, 0.55],
      [0.75, 0.7],
      [1, 1],
    ];
    const f = monotoneSpline(points);
    const h = 1e-6;
    for (const [x] of points.slice(1, -1)) {
      const left = (f(x) - f(x - h)) / h;
      const right = (f(x + h) - f(x)) / h;
      expect(Math.abs(left - right)).toBeLessThan(1e-4);
    }
  });

  it('за крайними точками держит их значения', () => {
    const f = monotoneSpline([
      [0.1, 0.2],
      [0.9, 0.8],
    ]);
    expect(f(0)).toBe(0.2);
    expect(f(0.05)).toBe(0.2);
    expect(f(0.95)).toBe(0.8);
    expect(f(1)).toBe(0.8);
  });

  it('сортирует точки и отбрасывает повтор x', () => {
    const f = monotoneSpline([
      [1, 1],
      [0, 0],
      [0.5, 0.7],
      [0.5, 0.2],
    ]);
    expect(f(0.5)).toBeCloseTo(0.7, 14);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it('одна точка — константа, без точек — тождество', () => {
    expect(monotoneSpline([[0.3, 0.6]])(0.9)).toBe(0.6);
    expect(monotoneSpline([])(0.42)).toBe(0.42);
  });

  it('sampleCurve даёт таблицу n значений от x = 0 до x = 1', () => {
    const table = sampleCurve(
      [
        [0, 0.1],
        [1, 0.9],
      ],
      5,
    );
    expect(table).toBeInstanceOf(Float64Array);
    expect([...table].map((v) => Number(v.toFixed(12)))).toEqual([0.1, 0.3, 0.5, 0.7, 0.9]);
  });
});
