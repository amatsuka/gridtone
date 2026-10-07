import { describe, expect, test } from 'vitest';
import { applyAffine, gridWindowTransform } from '@core/project/crop';
import { createCrop } from '@core/project/defaults';
import type { Crop } from '@core/project/types';

function crop(feed: Partial<Crop['feed']> = {}, grid: Partial<Crop['grid']> = {}): Crop {
  const base = createCrop();
  return { feed: { ...base.feed, ...feed }, grid: { ...base.grid, ...grid } };
}

/** Окно сетки в координатах изображения: углы плитки (0,0) и (1,1). */
function windowOf(w: number, h: number, c: Crop, ratio: '3:4' | '1:1' = '3:4') {
  const m = gridWindowTransform(w, h, c, ratio);
  const [u0, v0] = applyAffine(m, 0, 0);
  const [u1, v1] = applyAffine(m, 1, 1);
  return { u0, v0, u1, v1 };
}

function expectWindow(actual: ReturnType<typeof windowOf>, expected: ReturnType<typeof windowOf>) {
  for (const key of ['u0', 'v0', 'u1', 'v1'] as const) expect(actual[key]).toBeCloseTo(expected[key], 12);
}

describe('окно сетки внутри кадра', () => {
  test('кадр по умолчанию на фото 3:4 — всё фото', () => {
    expectWindow(windowOf(3024, 4032, createCrop()), { u0: 0, v0: 0, u1: 1, v1: 1 });
  });

  test('альбомное фото: центральное окно 3:4 на всю высоту', () => {
    // Кадр ленты 3:4 в фото 4000 × 3000: 2250 × 3000 по центру.
    expectWindow(windowOf(4000, 3000, createCrop()), { u0: 0.21875, v0: 0, u1: 0.78125, v1: 1 });
  });

  test('сетка 1:1 — квадрат внутри кадра 3:4', () => {
    expectWindow(windowOf(3000, 4000, createCrop(), '1:1'), { u0: 0, v0: 0.125, u1: 1, v1: 0.875 });
  });

  test('окно сетки двигается внутри кадра ленты и не выходит за него', () => {
    // Кадр ленты 4:5 в фото 4000 × 5000 — всё фото; окно 3:4 — 3750 × 5000, двигается по горизонтали.
    expectWindow(windowOf(4000, 5000, crop({ aspect: '4:5' }, { cx: 0 })), { u0: 0, v0: 0, u1: 0.9375, v1: 1 });
    expectWindow(windowOf(4000, 5000, crop({ aspect: '4:5' }, { cx: 1 })), { u0: 0.0625, v0: 0, u1: 1, v1: 1 });
  });

  test('увеличение уменьшает кадр вокруг центра, центр не даёт кадру выйти за фото', () => {
    expectWindow(windowOf(3000, 4000, crop({ zoom: 2 })), { u0: 0.25, v0: 0.25, u1: 0.75, v1: 0.75 });
    expectWindow(windowOf(3000, 4000, crop({ zoom: 2, cx: 0, cy: 1 })), { u0: 0, v0: 0.5, u1: 0.5, v1: 1 });
  });

  test('поворот вращает окно вокруг его центра', () => {
    const m = gridWindowTransform(3000, 4000, crop({ zoom: 2, angle: 90 }), '3:4');
    const [cu, cv] = applyAffine(m, 0.5, 0.5);
    expect(cu).toBeCloseTo(0.5, 12);
    expect(cv).toBeCloseTo(0.5, 12);
    // Сторона окна сохраняет длину в пикселях, а направление поворачивается на 90°.
    const [u0, v0] = applyAffine(m, 0, 0.5);
    const [u1, v1] = applyAffine(m, 1, 0.5);
    const dx = (u1 - u0) * 3000;
    const dy = (v1 - v0) * 4000;
    expect(Math.abs(dx)).toBeLessThan(1e-9);
    expect(Math.abs(dy)).toBeCloseTo(1500, 9);
  });
});
