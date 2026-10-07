import { describe, expect, test } from 'vitest';
import {
  applyAffine,
  corners,
  cropGeometry,
  dragFeed,
  dragGridWindow,
  feedFrameTransform,
  gridWindowTransform,
  zoomByHandle,
  type Affine,
} from '@core/project/crop';
import { createCrop } from '@core/project/defaults';
import type { Crop, Ratio } from '@core/project/types';
import { CROP_ANGLE_MAX, CROP_ZOOM_MAX, isValidCrop } from '@core/project/validate';

function crop(feed: Partial<Crop['feed']> = {}, grid: Partial<Crop['grid']> = {}): Crop {
  const base = createCrop();
  return { feed: { ...base.feed, ...feed }, grid: { ...base.grid, ...grid } };
}

/** Окно сетки в координатах изображения: углы плитки (0,0) и (1,1). */
function windowOf(w: number, h: number, c: Crop, ratio: Ratio = '3:4') {
  const m = gridWindowTransform(w, h, c, ratio);
  const [u0, v0] = applyAffine(m, 0, 0);
  const [u1, v1] = applyAffine(m, 1, 1);
  return { u0, v0, u1, v1 };
}

function expectWindow(actual: ReturnType<typeof windowOf>, expected: ReturnType<typeof windowOf>) {
  for (const key of ['u0', 'v0', 'u1', 'v1'] as const) expect(actual[key]).toBeCloseTo(expected[key], 12);
}

/** Генератор с постоянным зерном (mulberry32): случайные, но одни и те же наборы. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASPECTS: Crop['feed']['aspect'][] = ['4:5', '3:4', '1:1'];
const RATIOS: Ratio[] = ['3:4', '1:1'];
const SIZES: [number, number][] = [
  [3024, 4032],
  [4032, 3024],
  [1200, 3000],
  [3000, 1000],
  [1080, 1350],
  [1600, 1600],
  [512, 683],
];

interface Case {
  w: number;
  h: number;
  crop: Crop;
  ratio: Ratio;
}

/** Случайные кадры, в том числе с центром у самого края и за пределами допустимой области. */
function randomCases(seed: number, count: number, angle: (rnd: () => number) => number): Case[] {
  const rnd = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  return Array.from({ length: count }, () => {
    const [w, h] = pick(SIZES);
    const edge = () => pick([0, 1, rnd(), rnd(), 0.5]);
    return {
      w,
      h,
      ratio: pick(RATIOS),
      crop: crop(
        { aspect: pick(ASPECTS), cx: edge(), cy: edge(), zoom: pick([1, 1, 1 + rnd() * 3, 10]), angle: angle(rnd) },
        { cx: edge(), cy: edge() },
      ),
    };
  });
}

const EPS = 1e-9;

/** Все точки внутри фото 0..1 с допуском на округление. */
function expectInside(points: readonly (readonly [number, number])[], label: string) {
  for (const [u, v] of points) {
    expect(u, label).toBeGreaterThanOrEqual(-EPS);
    expect(u, label).toBeLessThanOrEqual(1 + EPS);
    expect(v, label).toBeGreaterThanOrEqual(-EPS);
    expect(v, label).toBeLessThanOrEqual(1 + EPS);
  }
}

/** Реализация этапа 1 без ограничения поворота — эталон «без поворота бит в бит прежний». */
function legacyGridWindowTransform(width: number, height: number, c: Crop, ratio: Ratio): Affine {
  const FEED_ASPECT = { '4:5': 4 / 5, '3:4': 3 / 4, '1:1': 1 };
  const GRID_ASPECT = { '3:4': 3 / 4, '1:1': 1 };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const { feed, grid } = c;
  const feedAspect = FEED_ASPECT[feed.aspect];
  const fw = Math.min(width, height * feedAspect) / feed.zoom;
  const fh = fw / feedAspect;
  const fcx = clamp(feed.cx * width, fw / 2, width - fw / 2);
  const fcy = clamp(feed.cy * height, fh / 2, height - fh / 2);
  const gridAspect = GRID_ASPECT[ratio];
  const gw = Math.min(fw, fh * gridAspect);
  const gh = gw / gridAspect;
  const gx = clamp(grid.cx * fw, gw / 2, fw - gw / 2) - fw / 2;
  const gy = clamp(grid.cy * fh, gh / 2, fh - gh / 2) - fh / 2;
  const rad = (feed.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (u: number, v: number): [number, number] => {
    const x = (u - 0.5) * gw + gx;
    const y = (v - 0.5) * gh + gy;
    return [(fcx + x * cos - y * sin) / width, (fcy + x * sin + y * cos) / height];
  };
  const [c0, f] = map(0, 0);
  const [ua, va] = map(1, 0);
  const [ub, vb] = map(0, 1);
  return [ua - c0, ub - c0, c0, va - f, vb - f, f];
}

/** Стороны четырёхугольника и угол первой стороны в пикселях фото. */
function shape(points: readonly [number, number][], w: number, h: number) {
  const px = points.map(([u, v]) => [u * w, v * h] as const);
  const side = (i: number, j: number) => Math.hypot(px[j]![0] - px[i]![0], px[j]![1] - px[i]![1]);
  const angle = (Math.atan2(px[1]![1] - px[0]![1], px[1]![0] - px[0]![0]) * 180) / Math.PI;
  return { width: side(0, 1), height: side(1, 2), angle };
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
    const m = gridWindowTransform(3000, 4000, crop({ zoom: 2, angle: 45 }), '3:4');
    const [cu, cv] = applyAffine(m, 0.5, 0.5);
    expect(cu).toBeCloseTo(0.5, 12);
    expect(cv).toBeCloseTo(0.5, 12);
    // Верхняя сторона окна в пикселях фото повёрнута на 45° по часовой (ось y вниз).
    expect(shape(corners(m), 3000, 4000).angle).toBeCloseTo(45, 9);
  });

  test('3:4 окно в любом кадре ленты — на всю его высоту: 4:5, 3:4 и 1:1 не уже 3:4', () => {
    for (const aspect of ASPECTS) {
      const g = cropGeometry(3000, 6000, crop({ aspect }), '3:4');
      expect(g.gridSize[1], aspect).toBeCloseTo(g.feedSize[1], 9);
      expect(g.gridRoom[1], aspect).toBeCloseTo(0, 9);
    }
  });
});

describe('без поворота — бит в бит как на этапе 1', () => {
  test('случайные кадры, фото и сетки', () => {
    for (const { w, h, crop: c, ratio } of randomCases(1, 2000, () => 0)) {
      expect(gridWindowTransform(w, h, c, ratio)).toEqual(legacyGridWindowTransform(w, h, c, ratio));
    }
  });

  test('угол −0 — тоже', () => {
    const c = crop({ aspect: '4:5', cx: 0.2, cy: 0.9, zoom: 1.7, angle: -0 }, { cx: 0.1, cy: 0.8 });
    expect(gridWindowTransform(4032, 3024, c, '3:4')).toEqual(legacyGridWindowTransform(4032, 3024, c, '3:4'));
  });
});

describe('повёрнутый кадр не выходит за фото', () => {
  const cases = randomCases(2, 3000, (rnd) => (rnd() * 2 - 1) * CROP_ANGLE_MAX);

  test('углы кадра ленты и окна сетки внутри фото', () => {
    for (const { w, h, crop: c, ratio } of cases) {
      const label = `${w}×${h} ${JSON.stringify(c)} ${ratio}`;
      expectInside(corners(feedFrameTransform(w, h, c)), `кадр ${label}`);
      expectInside(corners(gridWindowTransform(w, h, c, ratio)), `окно ${label}`);
    }
  });

  test('кадр сохраняет пропорции и поворачивается на заданный угол', () => {
    for (const { w, h, crop: c } of cases.slice(0, 300)) {
      const s = shape(corners(feedFrameTransform(w, h, c)), w, h);
      const aspect = { '4:5': 4 / 5, '3:4': 3 / 4, '1:1': 1 }[c.feed.aspect];
      expect(s.width / s.height).toBeCloseTo(aspect, 9);
      expect(s.angle).toBeCloseTo(c.feed.angle, 9);
    }
  });

  test('при zoom 1 и центре по середине кадр — наибольший: касается краёв фото', () => {
    for (const { w, h, crop: c } of cases.slice(0, 300)) {
      const centered = crop({ ...c.feed, cx: 0.5, cy: 0.5, zoom: 1 });
      const points = corners(feedFrameTransform(w, h, centered));
      const us = points.map(([u]) => u);
      const vs = points.map(([, v]) => v);
      const touchesSides = Math.min(...us) < 1e-9 && Math.max(...us) > 1 - 1e-9;
      const touchesTopBottom = Math.min(...vs) < 1e-9 && Math.max(...vs) > 1 - 1e-9;
      expect(touchesSides || touchesTopBottom, `${w}×${h} ${c.feed.aspect} ${c.feed.angle}°`).toBe(true);
    }
  });

  test('увеличение уменьшает повёрнутый кадр в zoom раз', () => {
    const base = cropGeometry(3024, 4032, crop({ aspect: '4:5', angle: 12 }), '3:4');
    const zoomed = cropGeometry(3024, 4032, crop({ aspect: '4:5', angle: 12, zoom: 2.5 }), '3:4');
    expect(zoomed.feedSize[0]).toBeCloseTo(base.feedSize[0] / 2.5, 9);
  });

  test('центр сдвигается в допустимую область: кадр прижат к углу фото', () => {
    // Центр в левом нижнем углу — кадр упирается в левый и нижний края.
    const points = corners(feedFrameTransform(3000, 4000, crop({ angle: 15, zoom: 2, cx: 0, cy: 1 })));
    expect(Math.min(...points.map(([u]) => u))).toBeCloseTo(0, 12);
    expect(Math.max(...points.map(([, v]) => v))).toBeCloseTo(1, 12);
  });

  test('при малом угле кадр почти прежний: ограничение непрерывно', () => {
    const c = crop({ aspect: '4:5', cx: 0.3, cy: 0.7, zoom: 1.5 }, { cx: 0.2 });
    const flat = gridWindowTransform(4032, 3024, c, '3:4');
    const tilted = gridWindowTransform(4032, 3024, crop({ ...c.feed, angle: 1e-7 }, c.grid), '3:4');
    flat.forEach((value, i) => expect(tilted[i]).toBeCloseTo(value, 6));
  });

  test('альбомное фото, 45°: квадратный кадр вписан ромбом', () => {
    // Квадрат со стороной s под 45° занимает по ширине и высоте s·√2: s = 3000 / √2.
    const g = cropGeometry(4000, 3000, crop({ aspect: '1:1', angle: 45 }), '1:1');
    expect(g.feedSize[0]).toBeCloseTo(3000 / Math.SQRT2, 9);
    expect(g.feedRoom[1]).toBeCloseTo(0, 9);
    expect(g.feedRoom[0]).toBeCloseTo(500, 9);
  });
});

describe('редактор: перемещение кадра ленты', () => {
  test('сдвиг указателя двигает центр кадра на ту же долю фото', () => {
    // Кадр 4:5 в фото 1200 × 3000: 1200 × 1500, ходит только по вертикали.
    const next = dragFeed(1200, 3000, crop({ aspect: '4:5' }), [0.3, 0.1]);
    expect(next.feed.cy).toBeCloseTo(0.6, 9);
    // По горизонтали хода нет: значение не меняется.
    expect(next.feed.cx).toBe(0.5);
  });

  test('кадр упирается в край фото', () => {
    expect(dragFeed(1200, 3000, crop({ aspect: '4:5' }), [0, 0.9]).feed.cy).toBeCloseTo(0.75, 9);
    expect(dragFeed(1200, 3000, crop({ aspect: '4:5' }), [0, -0.9]).feed.cy).toBeCloseTo(0.25, 9);
  });

  test('сдвиг начинается с видимого положения, а не с сохранённого за краем', () => {
    // Сохранено cy = 1, но кадр стоит у нижнего края (0.75): шаг вверх сразу двигает его.
    expect(dragFeed(1200, 3000, crop({ aspect: '4:5', cy: 1 }), [0, -0.05]).feed.cy).toBeCloseTo(0.7, 9);
  });

  test('повёрнутый кадр упирается в край по своему описанному прямоугольнику', () => {
    const next = dragFeed(3000, 4000, crop({ angle: 20, zoom: 2 }), [-1, 1]);
    const points = corners(feedFrameTransform(3000, 4000, next));
    expect(Math.min(...points.map(([u]) => u))).toBeCloseTo(0, 3);
    expect(Math.max(...points.map(([, v]) => v))).toBeCloseTo(1, 3);
  });

  test('окно сетки и остальные поля не меняются', () => {
    const before = crop({ aspect: '1:1', zoom: 2, angle: 5 }, { cx: 0.2, cy: 0.7 });
    const next = dragFeed(4000, 3000, before, [0.1, 0.1]);
    expect(next.grid).toEqual(before.grid);
    expect({ ...next.feed, cx: 0, cy: 0 }).toEqual({ ...before.feed, cx: 0, cy: 0 });
  });
});

describe('редактор: перемещение окна сетки', () => {
  test('окно ходит внутри кадра, пока есть запас, кадр стоит', () => {
    // Кадр 4:5 — всё фото 4000 × 5000, окно 3:4 — 3750 × 5000: запас 125 px в каждую сторону.
    const next = dragGridWindow(4000, 5000, crop({ aspect: '4:5' }), '3:4', [-100 / 4000, 0]);
    expect(next.grid.cx).toBeCloseTo((2000 - 100) / 4000, 9);
    expect(next.feed).toEqual(crop({ aspect: '4:5' }).feed);
  });

  test('у края кадра окно толкает кадр', () => {
    // Фото 1200 × 3000, кадр 4:5 — 1200 × 1500, окно 3:4 — на всю его высоту: вниз окно тянет кадр.
    const next = dragGridWindow(1200, 3000, crop({ aspect: '4:5' }), '3:4', [0, 0.1]);
    expect(next.feed.cy).toBeCloseTo(0.6, 9);
    expect(next.grid.cy).toBe(0.5);
    // До упора вниз: окно сетки показывает низ фото.
    const bottom = dragGridWindow(1200, 3000, crop({ aspect: '4:5' }), '3:4', [0, 0.6]);
    expect(bottom.feed.cy).toBeCloseTo(0.75, 9);
    expect(applyAffine(gridWindowTransform(1200, 3000, bottom, '3:4'), 0.5, 1)[1]).toBeCloseTo(1, 9);
  });

  test('сначала выбирается запас окна, остаток двигает кадр', () => {
    // Кадр 1:1 в фото 3000 × 4000 (zoom 2): 1500 × 1500, окно 3:4 — 1125 × 1500, запас 187.5 px.
    const start = crop({ aspect: '1:1', zoom: 2 });
    const next = dragGridWindow(3000, 4000, start, '3:4', [300 / 3000, 0]);
    // Окно у правого края кадра: его центр — 1500 − 562.5 = 937.5 px от левого края кадра.
    expect(next.grid.cx).toBeCloseTo(937.5 / 1500, 6);
    expect(next.feed.cx).toBeCloseTo((1500 + 112.5) / 3000, 6);
  });

  test('в повёрнутом кадре сдвиг указателя переводится в оси кадра', () => {
    // Кадр 1:1 повёрнут на 30°: шаг указателя вдоль верхней стороны кадра сдвигает окно только по его оси x.
    const start = crop({ aspect: '1:1', zoom: 2, angle: 30 });
    const step = 50;
    const rad = (30 * Math.PI) / 180;
    const next = dragGridWindow(3000, 4000, start, '3:4', [(step * Math.cos(rad)) / 3000, (step * Math.sin(rad)) / 4000]);
    const before = cropGeometry(3000, 4000, start, '3:4');
    const after = cropGeometry(3000, 4000, next, '3:4');
    expect(after.gridOffset[0] - before.gridOffset[0]).toBeCloseTo(step, 1);
    expect(after.gridOffset[1]).toBeCloseTo(before.gridOffset[1], 9);
    expect(next.feed).toEqual(start.feed);
  });

  test('без запаса по оси сохранённое значение окна не меняется', () => {
    // Кадр 3:4 и окно 3:4 совпадают: окну некуда двигаться, сдвиг целиком уходит в кадр.
    const start = crop({ zoom: 2 }, { cx: 0.1, cy: 0.9 });
    const next = dragGridWindow(3000, 4000, start, '3:4', [0.05, 0.05]);
    expect(next.grid).toEqual(start.grid);
    expect(next.feed.cx).toBeCloseTo(0.55, 9);
    expect(next.feed.cy).toBeCloseTo(0.55, 9);
  });
});

describe('редактор: масштаб за угол кадра', () => {
  test('угол дальше от центра — кадр больше, ближе — меньше', () => {
    const start = crop({ zoom: 2 });
    // Центр кадра — (0.5, 0.5); угол уводится вдвое дальше от центра: zoom вдвое меньше.
    expect(zoomByHandle(3000, 4000, start, [0.6, 0.6], [0.7, 0.7]).feed.zoom).toBeCloseTo(1, 3);
    expect(zoomByHandle(3000, 4000, start, [0.6, 0.6], [0.55, 0.55]).feed.zoom).toBeCloseTo(4, 3);
  });

  test('масштаб в пределах 1…CROP_ZOOM_MAX', () => {
    expect(zoomByHandle(3000, 4000, crop({ zoom: 2 }), [0.6, 0.6], [1, 1]).feed.zoom).toBe(1);
    expect(zoomByHandle(3000, 4000, crop({ zoom: 2 }), [0.6, 0.6], [0.5, 0.5]).feed.zoom).toBe(CROP_ZOOM_MAX);
  });
});

describe('правки редактора дают допустимый кадр', () => {
  test('случайные сдвиги и масштабы проходят isValidCrop', () => {
    const rnd = random(3);
    const cases = randomCases(4, 500, (r) => (r() * 2 - 1) * CROP_ANGLE_MAX);
    for (const { w, h, crop: c, ratio } of cases) {
      const delta: [number, number] = [rnd() * 2 - 1, rnd() * 2 - 1];
      const point: [number, number] = [rnd(), rnd()];
      for (const next of [
        dragFeed(w, h, c, delta),
        dragGridWindow(w, h, c, ratio, delta),
        zoomByHandle(w, h, c, point, [rnd(), rnd()]),
      ]) {
        expect(isValidCrop(next), JSON.stringify(next)).toBe(true);
        expectInside(corners(gridWindowTransform(w, h, next, ratio)), JSON.stringify(next));
      }
    }
  });
});
