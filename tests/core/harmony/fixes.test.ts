import { describe, expect, it } from 'vitest';
import type { PipelineParams } from '@core/color/bake';
import { hueDistance } from '@core/color/math';
import type { Rgb } from '@core/color/srgb';
import { lchToSrgb } from '@core/color/swatches';
import {
  applyFix,
  findFix,
  FIX_LIMITS,
  formatFix,
  HUE_FIX_MARGIN,
  reasonValue,
  SEARCH_STRIDE,
  searchSlider,
  searchWindow,
  windowMeans,
  withFix,
  type FixTarget,
  type TileFix,
} from '@core/harmony/fixes';
import type { RgbaImage } from '@core/image/sample';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { meanHue, temperature } from '@core/metrics/features';
import { metricsWindowSize, tileMetrics, windowRgb, type TileMetrics } from '@core/metrics/tile';
import { createAdjust, createCrop } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';
import { seededRandom } from '../color/helpers';

const CROP = createCrop();
const RATIO = '3:4';

function image(width: number, height: number, color: (x: number, y: number) => Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      color(x / width, y / height).forEach((v, c) => (data[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255)));
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Фото с фактурой: два градиента, полосы и шум — средние окна поиска и полного окна различаются. */
function textured(seed = 3): RgbaImage {
  const random = seededRandom(seed);
  return image(384, 512, (x, y) => {
    const stripe = Math.floor(y * 23) % 2 === 0 ? 0.08 : -0.05;
    const noise = (random() - 0.5) * 0.12;
    return [0.25 + 0.5 * x + stripe + noise, 0.3 + 0.35 * y + noise, 0.45 - 0.25 * x + 0.2 * y - stripe];
  });
}

/** Однотонное фото цвета OKLCH. */
const solid = (L: number, C: number, h: number) => image(60, 80, () => lchToSrgb(L, C, h));

const adjust = (patch: Partial<Adjust>): Adjust => ({ ...createAdjust(), ...patch });

/** Мягкий образ: контраст, приглушённые света, лёгкая насыщенность. */
const LOOK = adjust({ contrast: 25, highlights: -20, saturation: 15, temp: 8 });
/** LUT образа, запечённый из другой коррекции: не тождество и не перестановочен с поправкой фото. */
const LUT = bakeLut(lookPipeline(adjust({ contrast: -15, shadows: 20, vibrance: 25, tint: 10 })), 17);

function sparse(photo: RgbaImage): Float32Array {
  return searchWindow(windowRgb(photo, CROP, RATIO), RATIO);
}

function metrics(photo: RgbaImage, params: PipelineParams): TileMetrics {
  return tileMetrics(photo, CROP, RATIO, params);
}

/** Признаки после поправки — по полному окну метрик, как их посчитает воркер. */
function after(photo: RgbaImage, params: PipelineParams, fix: TileFix): TileMetrics {
  return metrics(photo, { ...params, photo: withFix(params.photo, fix) });
}

function target(reason: FixTarget['reason'], value: number, expected: number, tolerance: number, source: FixTarget['source'] = 'grid'): FixTarget {
  return { reason, value, expected, tolerance, source };
}

describe('окно поиска', () => {
  it('каждая вторая точка окна метрик по обеим осям', () => {
    const full = windowRgb(textured(), CROP, RATIO);
    const [width, height] = metricsWindowSize(RATIO);
    const window = searchWindow(full, RATIO);
    const w = width / SEARCH_STRIDE;
    expect(window.length).toBe(w * (height / SEARCH_STRIDE) * 3);
    for (const [x, y] of [
      [0, 0],
      [5, 7],
      [w - 1, height / SEARCH_STRIDE - 1],
    ] as const) {
      for (let c = 0; c < 3; c++) expect(window[(y * w + x) * 3 + c]).toBe(full[(y * SEARCH_STRIDE * width + x * SEARCH_STRIDE) * 3 + c]);
    }
    expect(() => searchWindow(new Float32Array(30), RATIO)).toThrow();
  });

  it('прореженное окно против полного окна метрик: средние почти те же, с образом и LUT', () => {
    const photo = textured();
    for (const params of [{ photo: createAdjust() }, { photo: adjust({ exposure: 0.4, temp: -15, saturation: 20 }), look: LOOK, lut: LUT }]) {
      const m = windowMeans(sparse(photo), params);
      const full = metrics(photo, params);
      expect(Math.abs(m.meanL - full.meanL)).toBeLessThan(0.003);
      expect(Math.abs(m.meanA - full.meanA)).toBeLessThan(0.0015);
      expect(Math.abs(m.meanB - full.meanB)).toBeLessThan(0.0015);
      expect(Math.abs(m.meanC - full.meanC)).toBeLessThan(0.0015);
      expect(Math.abs(reasonValue('temperature', m) - temperature(full.meanA, full.meanB))).toBeLessThan(0.0015);
    }
  });
});

describe('бинарный поиск ползунка', () => {
  it('попадает в цель с шагом ползунка; цель вне диапазона — ближайший край', () => {
    const f = (v: number) => 0.2 + 0.01 * v;
    expect(searchSlider(f, -20, 20, 0.27, 1)).toEqual({ value: 7, exact: true });
    expect(searchSlider(f, -20, 20, 0.5, 1)).toEqual({ value: 20, exact: false });
    expect(searchSlider(f, -20, 20, -0.1, 1)).toEqual({ value: -20, exact: false });
    expect(searchSlider(f, -20, 20, 0, 1)).toEqual({ value: -20, exact: true });
    // Убывающая величина и шаг 0.01: значение без хвостов плавающей точки.
    expect(searchSlider((v) => -v * v * v, 0, 1, -0.027, 0.01)).toEqual({ value: 0.3, exact: true });
  });

  it('первая точка деления — догадка, если она внутри', () => {
    const probes: number[] = [];
    const f = (v: number) => {
      probes.push(v);
      return v;
    };
    searchSlider(f, -30, 30, 12.3, 1, 12);
    expect(probes[2]).toBe(12);
    probes.length = 0;
    searchSlider(f, -30, 30, 12.3, 1, 45);
    expect(probes[2]).toBe(0);
  });
});

describe('экспозиция и температура — через весь конвейер', () => {
  const photo = textured();
  const params: PipelineParams = { photo: adjust({ exposure: 0.2, temp: 10, contrast: 10 }), look: LOOK, lut: LUT };
  const before = metrics(photo, params);

  it('экспозиция ведёт L к ожиданию, с образом и LUT поверх поправки фото', () => {
    for (const shift of [0.07, -0.09]) {
      const expected = before.meanL + shift;
      const fix = findFix(sparse(photo), params, target('L', before.meanL, expected, 0.06));
      expect(fix.slider).toBe('exposure');
      expect(fix.exact).toBe(true);
      expect(fix.replace).toBe(false);
      expect(fix.from).toBe(0.2);
      expect(Math.sign(fix.value - fix.from)).toBe(Math.sign(shift));
      expect(Number.isInteger(Math.round(fix.value * 100))).toBe(true);
      expect(Math.abs(fix.reached - expected)).toBeLessThan(0.002);
      expect(Math.abs(after(photo, params, fix).meanL - expected)).toBeLessThan(0.004);
    }
  });

  it('температура ведёт температуру плитки к ожиданию', () => {
    const T = temperature(before.meanA, before.meanB);
    for (const shift of [-0.011, 0.009]) {
      const fix = findFix(sparse(photo), params, target('temperature', T, T + shift, 0.01));
      expect(fix.slider).toBe('temp');
      expect(fix.exact).toBe(true);
      expect(Number.isInteger(fix.value)).toBe(true);
      expect(Math.sign(fix.value - 10)).toBe(Math.sign(shift));
      const m = after(photo, params, fix);
      expect(Math.abs(temperature(m.meanA, m.meanB) - (T + shift))).toBeLessThan(0.0015);
    }
  });

  it('образ, убивающий цвет, — температуру не поправить: «заменить»', () => {
    // Монохромный образ: насыщенность −100 — температура после него от поправки фото не зависит.
    const mono: PipelineParams = { photo: createAdjust(), look: adjust({ saturation: -100 }) };
    const m = metrics(photo, mono);
    const T = temperature(m.meanA, m.meanB);
    const fix = findFix(sparse(photo), mono, target('temperature', T, T + 0.02, 0.01));
    expect(fix.replace).toBe(true);
    expect(fix.exact).toBe(false);
  });
});

describe('лимит от текущего значения и пределы ползунков', () => {
  const photo = solid(0.5, 0.02, 250);
  const at = (exposure: number) => metrics(photo, { photo: adjust({ exposure }) }).meanL;

  it('±1 EV от текущей экспозиции: за лимитом — лучшее в лимите и «заменить»', () => {
    const fix = findFix(sparse(photo), { photo: adjust({ exposure: -1 }) }, target('L', at(-1), at(0.6), 0.06));
    expect(fix.range).toEqual([-2, 0]);
    expect(fix.value).toBe(0);
    expect(fix.exact).toBe(false);
    expect(fix.replace).toBe(true);
    expect(Math.abs(fix.reached - at(0))).toBeLessThan(0.002);
    expect(fix.ratio).toBeGreaterThan(1);
  });

  it('цель чуть за лимитом, а лучшее в лимите — в допуске: поправка без «заменить»', () => {
    const fix = findFix(sparse(photo), { photo: createAdjust() }, target('L', at(0), at(1.1), 0.06));
    expect(fix.value).toBe(1);
    expect(fix.exact).toBe(false);
    expect(fix.replace).toBe(false);
    expect(fix.ratio).toBeLessThan(1);
  });

  it('пределы ползунков срезают лимит', () => {
    const high = findFix(sparse(photo), { photo: adjust({ exposure: 2.5 }) }, target('L', at(2.5), 0.99, 0.06));
    expect(high.range).toEqual([1.5, 3]);
    expect(high.value).toBe(3);
    const cold = findFix(sparse(photo), { photo: adjust({ temp: -90 }) }, target('temperature', 0, -1, 0.01));
    expect(cold.range).toEqual([-100, -70]);
    expect(cold.value).toBe(-100);
    const muted = findFix(sparse(photo), { photo: adjust({ saturation: 85 }) }, target('chroma', 0.02, 0.5, 0.01));
    expect(muted.range).toEqual([55, 100]);
    expect(FIX_LIMITS).toEqual({ exposure: 1, temp: 20, saturation: 30 });
  });
});

describe('насыщенность — по отношению хром с уточнением поиском', () => {
  it('однотонная плитка: ровно отношение хром', () => {
    const photo = solid(0.65, 0.06, 150);
    const m = metrics(photo, { photo: createAdjust() });
    const fix = findFix(sparse(photo), { photo: createAdjust() }, target('chroma', m.meanC, m.meanC * 1.2, 0.01));
    expect(fix.slider).toBe('saturation');
    expect(fix.value).toBe(20);
    expect(fix.replace).toBe(false);
  });

  it('срез в охват: насыщенные точки не растут, поиск добирает сверх отношения', () => {
    // Половина кадра — красный у края охвата, половина — приглушённый голубой.
    const photo = image(60, 80, (x) => (x < 0.5 ? [0.9, 0.2, 0.15] : [0.45, 0.55, 0.6]));
    const m = metrics(photo, { photo: createAdjust() });
    const expected = m.meanC * 1.18;
    const fix = findFix(sparse(photo), { photo: createAdjust() }, target('chroma', m.meanC, expected, 0.01));
    expect(fix.exact).toBe(true);
    expect(fix.value).toBeGreaterThan(21);
    expect(Math.abs(after(photo, { photo: createAdjust() }, fix).meanC - expected)).toBeLessThan(0.0007);
    // Одно отношение хром (+18) недобрало бы втрое больше.
    const byRatio = metrics(photo, { photo: adjust({ saturation: 18 }) }).meanC;
    expect(expected - byRatio).toBeGreaterThan(0.002);
  });

  it('у серой плитки насыщенности не за что взяться — «заменить»', () => {
    const photo = solid(0.6, 0, 0);
    const fix = findFix(sparse(photo), { photo: createAdjust() }, target('chroma', 0, 0.03, 0.01));
    expect(fix.replace).toBe(true);
  });
});

describe('тон — оба диапазона HSL вокруг тона плитки', () => {
  const hueOf = (m: TileMetrics) => meanHue(m.meanA, m.meanB);

  it('к ближайшему краю сектора с запасом внутрь; одна величина обоим диапазонам', () => {
    const photo = solid(0.6, 0.08, 232);
    const params = { photo: createAdjust() };
    const h = hueOf(metrics(photo, params));
    const fix = findFix(sparse(photo), params, target('hue', h, 214, 10));
    expect(fix.slider).toBe('hslHue');
    expect(fix.bands).toEqual(['aqua', 'blue']);
    expect(fix.target).toBeCloseTo(214 - HUE_FIX_MARGIN, 9);
    expect(fix.exact).toBe(true);
    expect(fix.ratio).toBe(0);
    // Сдвиг между центрами — ровно 30° · v / 100: около −21° — около −70.
    expect(Math.abs(fix.value - ((211 - h) / 30) * 100)).toBeLessThan(1.5);
    expect(hueDistance(hueOf(after(photo, params, fix)), 211)).toBeLessThan(0.5);
    const next = withFix(params.photo, fix);
    expect(next.hsl.aqua.hue).toBe(fix.value);
    expect(next.hsl.blue.hue).toBe(fix.value);
  });

  it('с другой стороны сектора и через 0°/360°', () => {
    for (const [hue, edge, bands, goal] of [
      [180, 190, ['green', 'aqua'], 193],
      [10, 352, ['magenta', 'red'], 349],
    ] as const) {
      const photo = solid(0.6, 0.08, hue);
      const params = { photo: createAdjust() };
      const fix = findFix(sparse(photo), params, target('hue', hueOf(metrics(photo, params)), edge, 10));
      expect(fix.bands).toEqual(bands);
      expect(fix.replace).toBe(false);
      expect(hueDistance(hueOf(after(photo, params, fix)), goal)).toBeLessThan(0.6);
    }
  });

  it('цель позиции — ровно её тон, без запаса', () => {
    const photo = solid(0.6, 0.08, 232);
    const params = { photo: createAdjust() };
    const fix = findFix(sparse(photo), params, target('hue', hueOf(metrics(photo, params)), 220, 20, 'target'));
    expect(fix.target).toBe(220);
    expect(hueDistance(hueOf(after(photo, params, fix)), 220)).toBeLessThan(0.5);
  });

  it('дальше 30° — за ползунком: «заменить» с лучшим в его пределах', () => {
    const photo = solid(0.6, 0.08, 232);
    const params = { photo: createAdjust() };
    const fix = findFix(sparse(photo), params, target('hue', hueOf(metrics(photo, params)), 185, 10));
    expect(fix.value).toBe(-100);
    expect(fix.exact).toBe(false);
    expect(fix.replace).toBe(true);
    expect(fix.range).toEqual([-100, 100]);
  });

  it('прежние значения диапазонов: сдвиг считается от их смеси на тоне плитки', () => {
    const photo = solid(0.6, 0.08, 232);
    const hsl = { ...createAdjust().hsl, aqua: { hue: 20, sat: 0, lum: 0 }, blue: { hue: -10, sat: 5, lum: 0 } };
    const params = { photo: adjust({ hsl }) };
    const fix = findFix(sparse(photo), params, target('hue', hueOf(metrics(photo, params)), 214, 10));
    expect(fix.from).toBeGreaterThan(-10);
    expect(fix.from).toBeLessThan(20);
    const next = withFix(params.photo, fix);
    expect(next.hsl.blue).toEqual({ hue: fix.value, sat: 5, lum: 0 });
    expect(params.photo.hsl.blue.hue).toBe(-10);
    expect(hueDistance(hueOf(after(photo, params, fix)), 211)).toBeLessThan(0.5);
  });
});

describe('«Применить» и подписи', () => {
  it('applyFix пишет одно значение ползунка; тон — обоим диапазонам', () => {
    const a = createAdjust();
    applyFix(a, { slider: 'exposure', value: 0.35 });
    applyFix(a, { slider: 'temp', value: -12 });
    applyFix(a, { slider: 'saturation', value: 18 });
    applyFix(a, { slider: 'hslHue', value: -40, bands: ['aqua', 'blue'] });
    expect(a).toEqual({
      ...createAdjust(),
      exposure: 0.35,
      temp: -12,
      saturation: 18,
      hsl: { ...createAdjust().hsl, aqua: { hue: -40, sat: 0, lum: 0 }, blue: { hue: -40, sat: 0, lum: 0 } },
    });
  });

  it('подпись — изменение ползунка', () => {
    expect(formatFix({ slider: 'exposure', from: 0.2, value: 0.55 })).toBe('Экспозиция +0.35 EV');
    expect(formatFix({ slider: 'temp', from: 0, value: -12 })).toBe('Температура −12');
    expect(formatFix({ slider: 'saturation', from: 5, value: 23 })).toBe('Насыщенность +18');
    expect(formatFix({ slider: 'hslHue', from: 0, value: -40, bands: ['aqua', 'blue'] })).toBe('Тон −40 · голубой и синий');
  });
});
