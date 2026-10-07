import { describe, expect, it } from 'vitest';
import { labStats, palette, PALETTE_SIZE, pixelWeight } from '@core/metrics/palette';
import type { Vec3 } from '@core/project/types';
import { seededRandom } from '../color/helpers';

/** Пиксели OKLab подряд: L, a, b. */
function labs(colors: readonly Vec3[]): Float32Array {
  return Float32Array.from(colors.flat());
}

function repeat(color: Vec3, count: number): Vec3[] {
  return Array.from({ length: count }, () => [...color] as Vec3);
}

/** Цвет с шумом: как однотонное фото после JPEG. */
function noisy(color: Vec3, count: number, random: () => number, amount = 0.002): Vec3[] {
  return Array.from({ length: count }, () => color.map((v) => v + (random() - 0.5) * amount) as Vec3);
}

function expectLab(actual: Vec3, expected: Vec3, digits = 4): void {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i] as number, digits));
}

const GRAY: Vec3 = [0.6, 0, 0];
const DARK: Vec3 = [0.25, 0, 0];
const RED: Vec3 = [0.63, 0.22, 0.12];
const TEAL: Vec3 = [0.7, -0.1, -0.03];

describe('палитра плитки: k-means в OKLab', () => {
  it('вес пикселя растёт с хромой, у серого он 1', () => {
    expect(pixelWeight(0)).toBe(1);
    expect(pixelWeight(0.1)).toBeGreaterThan(pixelWeight(0.05));
    expect(pixelWeight(0.3)).toBeGreaterThan(pixelWeight(0.1));
  });

  it('однотонное изображение — один цвет с долей 1', () => {
    const result = palette(labs(repeat(RED, 500)));
    expect(result).toHaveLength(1);
    expectLab(result[0]!.lab, RED, 6);
    expect(result[0]!.share).toBeCloseTo(1, 12);
  });

  it('два серых 70/30 — две доли 0.7 и 0.3 по убыванию', () => {
    const result = palette(labs([...repeat(GRAY, 700), ...repeat(DARK, 300)]));
    expect(result).toHaveLength(2);
    expectLab(result[0]!.lab, GRAY, 6);
    expect(result[0]!.share).toBeCloseTo(0.7, 12);
    expectLab(result[1]!.lab, DARK, 6);
    expect(result[1]!.share).toBeCloseTo(0.3, 12);
  });

  it('хрома добавляет вес: 20% красного весят больше 20%', () => {
    const result = palette(labs([...repeat(GRAY, 800), ...repeat(RED, 200)]));
    const red = result.find((entry) => entry.lab[1] > 0.1);
    expect(red?.share).toBeGreaterThan(0.3);
  });

  it('не больше 5 цветов, доли в сумме 1 и идут по убыванию', () => {
    const random = seededRandom(3);
    const pixels = Array.from({ length: 4000 }, () => [random(), random() * 0.4 - 0.2, random() * 0.4 - 0.2] as Vec3);
    const result = palette(labs(pixels));
    expect(result).toHaveLength(PALETTE_SIZE);
    expect(result.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 9);
    for (let i = 1; i < result.length; i++) expect(result[i]!.share).toBeLessThanOrEqual(result[i - 1]!.share);
  });

  it('детерминирован: тот же вход — та же палитра', () => {
    const random = seededRandom(11);
    const pixels = labs([...noisy(RED, 600, random), ...noisy(TEAL, 300, random), ...noisy(GRAY, 900, random)]);
    expect(palette(pixels)).toEqual(palette(pixels));
  });

  it('три цвета с шумом находятся, главный — с наибольшей взвешенной долей', () => {
    const random = seededRandom(17);
    const pixels = labs([...noisy(TEAL, 1500, random), ...noisy(RED, 300, random), ...noisy(DARK, 600, random)]);
    const result = palette(pixels);
    expectLab(result[0]!.lab, TEAL, 2);
    for (const color of [RED, DARK]) {
      const near = result.some((entry) => entry.lab.every((v, i) => Math.abs(v - (color[i] as number)) < 0.01));
      expect(near).toBe(true);
    }
  });

  it('однотонное фото с шумом — один цвет: близкие кластеры сливаются', () => {
    const random = seededRandom(23);
    const result = palette(labs(noisy(TEAL, 2000, random, 0.01)));
    expect(result).toHaveLength(1);
    expectLab(result[0]!.lab, TEAL, 3);
    expect(result[0]!.share).toBeCloseTo(1, 12);
  });

  it('большое однотонное небо не проигрывает меньшему объекту из-за дробления на кластеры', () => {
    const random = seededRandom(29);
    const sky: Vec3 = [0.75, -0.03, -0.08];
    const house: Vec3 = [0.45, 0.06, 0.05];
    const result = palette(labs([...noisy(sky, 2600, random, 0.012), ...noisy(house, 1400, random, 0.004)]));
    expectLab(result[0]!.lab, sky, 2);
  });

  it('пустое изображение — пустая палитра', () => {
    expect(palette(new Float32Array(0))).toEqual([]);
  });
});

describe('средние плитки', () => {
  it('средние L, a, b, хрома и тон среднего цвета', () => {
    const stats = labStats(labs([...repeat([0.4, 0.1, 0], 50), ...repeat([0.8, 0, 0.1], 50)]));
    expect(stats.meanL).toBeCloseTo(0.6, 6);
    expect(stats.meanA).toBeCloseTo(0.05, 6);
    expect(stats.meanB).toBeCloseTo(0.05, 6);
    // Средняя хрома — среднее хром пикселей, а не хрома среднего цвета.
    expect(stats.meanC).toBeCloseTo(0.1, 6);
    expect(stats.hue).toBeCloseTo(45, 6);
  });

  it('у серого тон 0 и хрома 0', () => {
    const stats = labStats(labs(repeat(GRAY, 10)));
    expect(stats.meanC).toBe(0);
    expect(stats.hue).toBe(0);
  });
});
