import { describe, expect, it } from 'vitest';
import { linearSrgbToOklab } from '@core/color/oklab';
import type { Rgb } from '@core/color/srgb';
import { decodeSrgb } from '@core/color/transfer';
import {
  applyView,
  grayOfL,
  levelL,
  oklabL,
  POSTERIZE_BOUNDARIES,
  POSTERIZE_LEVELS,
  posterizeLevel,
} from '@core/color/view';
import { colorLattice, randomColors } from './helpers';

const L = (rgb: Rgb) => linearSrgbToOklab(decodeSrgb(rgb))[0];

describe('режим 3: яркость', () => {
  it('серый с тем же OKLab L', () => {
    for (const c of [...randomColors(2000, 31), ...colorLattice(9)]) {
      const out = applyView(c, 'luminance');
      expect(out[0]).toBe(out[1]);
      expect(out[1]).toBe(out[2]);
      expect(L(out)).toBeCloseTo(L(c), 6);
    }
  });

  it('чёрное и белое остаются собой', () => {
    expect(applyView([0, 0, 0], 'luminance')).toEqual([0, 0, 0]);
    const white = applyView([1, 1, 1], 'luminance');
    for (const v of white) expect(v).toBeCloseTo(1, 6);
  });

  it('oklabL совпадает с L из OKLab', () => {
    for (const c of randomColors(200, 5)) expect(oklabL(c)).toBe(L(c));
  });

  it('режим цвета ничего не меняет', () => {
    for (const c of randomColors(200, 6)) expect(applyView(c, 'color')).toEqual(c);
  });
});

describe('режим 4: постеризация', () => {
  it('5 уровней L равными шагами, границы между ними', () => {
    expect(POSTERIZE_LEVELS).toBe(5);
    expect(POSTERIZE_BOUNDARIES).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(Array.from({ length: 5 }, (_, k) => levelL(k))).toEqual([0.1, 0.3, 0.5, 0.7, 0.9]);
  });

  it('номер уровня растёт с L и не выходит за 0..4', () => {
    expect(posterizeLevel(-0.1)).toBe(0);
    expect(posterizeLevel(0)).toBe(0);
    expect(posterizeLevel(0.19)).toBe(0);
    expect(posterizeLevel(0.21)).toBe(1);
    expect(posterizeLevel(0.5)).toBe(2);
    expect(posterizeLevel(0.79)).toBe(3);
    expect(posterizeLevel(0.81)).toBe(4);
    expect(posterizeLevel(1)).toBe(4);
    expect(posterizeLevel(1.2)).toBe(4);
    let prev = 0;
    for (let i = 0; i <= 1000; i++) {
      const k = posterizeLevel(i / 1000);
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
  });

  it('на выходе ровно 5 серых, у каждого L — середина своего уровня', () => {
    const outputs = new Map<string, Rgb>();
    for (const c of [...randomColors(3000, 9), ...colorLattice(17)]) {
      const out = applyView(c, 'posterize');
      expect(out[0]).toBe(out[1]);
      expect(out[1]).toBe(out[2]);
      outputs.set(out.join(','), out);
      expect(L(out)).toBeCloseTo(levelL(posterizeLevel(L(c))), 6);
    }
    expect(outputs.size).toBe(POSTERIZE_LEVELS);
  });

  it('grayOfL даёт серый с заданным L', () => {
    for (let i = 0; i <= 20; i++) expect(L(grayOfL(i / 20))).toBeCloseTo(i / 20, 6);
  });
});
