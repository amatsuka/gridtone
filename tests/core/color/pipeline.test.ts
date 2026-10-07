import { describe, expect, it } from 'vitest';
import { bakeAdjust, bakePipeline, CURVE_TABLE_SIZE } from '@core/color/bake';
import { applyBaked, applyPass, applyPipeline, processRgba8 } from '@core/color/pipeline';
import { LUMINANCE, type Rgb } from '@core/color/srgb';
import { decodeSrgb, encodeSrgb, linearToSrgb, srgbToLinear } from '@core/color/transfer';
import { monotoneSpline } from '@core/color/spline';
import { createAdjust } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';
import { randomAdjust } from '../../golden/cases';
import { colorLattice, randomColors, seededRandom } from './helpers';

function adjust(patch: Partial<Adjust>): Adjust {
  return { ...createAdjust(), ...patch };
}

const gray = (v: number): Rgb => [v, v, v];
const lum = (c: Rgb) => LUMINANCE[0] * c[0] + LUMINANCE[1] * c[1] + LUMINANCE[2] * c[2];

describe('подготовка параметров (bake)', () => {
  it('нейтральная коррекция — все шаги пропускаются', () => {
    expect(bakeAdjust(createAdjust())).toEqual({ linear: null, curves: null, color: null });
  });

  it('включаются только затронутые шаги', () => {
    const exposure = bakeAdjust(adjust({ exposure: 1 }));
    expect(exposure.linear).toEqual({ wb: [1, 1, 1], exposure: 2, tone: null });
    expect(exposure.curves).toBeNull();
    expect(exposure.color).toBeNull();

    const vibrance = bakeAdjust(adjust({ vibrance: 30 }));
    expect(vibrance.linear).toBeNull();
    expect(vibrance.color).toEqual({ hsl: null, grading: null, vibrance: 0.3, saturation: 0 });
  });

  it('таблица кривых: общая кривая уже внутри канальных', () => {
    const a = createAdjust();
    a.curves.master = [
      [0, 0],
      [0.5, 0.6],
      [1, 1],
    ];
    a.curves.r = [
      [0, 0.1],
      [1, 0.9],
    ];
    const table = bakeAdjust(a).curves;
    if (!table) throw new Error('ожидалась таблица кривых');
    expect(table).toHaveLength(CURVE_TABLE_SIZE * 4);
    const master = monotoneSpline(a.curves.master);
    const red = monotoneSpline(a.curves.r);
    for (const i of [0, 100, 511, 1023]) {
      const x = i / (CURVE_TABLE_SIZE - 1);
      expect(table[i * 4]).toBeCloseTo(red(master(x)), 6);
      expect(table[i * 4 + 1]).toBeCloseTo(master(x), 6);
    }
  });
});

describe('конвейер', () => {
  it('нейтральные параметры — точное тождество', () => {
    const colors = [...colorLattice(17), ...randomColors(2000, 7)];
    for (const c of colors) {
      expect(applyPipeline(c, { photo: createAdjust() })).toEqual(c);
      expect(applyPipeline(c, { photo: createAdjust(), look: createAdjust() })).toEqual(c);
    }
  });

  it('экспозиция умножает линейный свет на 2^EV', () => {
    const out = applyPipeline(gray(0.4), { photo: adjust({ exposure: 1 }) });
    for (const v of out) expect(v).toBeCloseTo(linearToSrgb(2 * srgbToLinear(0.4)), 12);
  });

  it('пересвет срезается до 1', () => {
    expect(applyPipeline(gray(0.9), { photo: adjust({ exposure: 2 }) })).toEqual([1, 1, 1]);
  });

  it('проход образа идёт вторым, поверх поправки фото', () => {
    const back = applyPipeline(gray(0.3), { photo: adjust({ exposure: 1 }), look: adjust({ exposure: -1 }) });
    for (const v of back) expect(v).toBeCloseTo(0.3, 12);
    // Порядок важен: сначала +2 EV срезает светлое, затем −2 EV его уже не вернёт.
    const clipped = applyPipeline(gray(0.8), { photo: adjust({ exposure: 2 }), look: adjust({ exposure: -2 }) });
    for (const v of clipped) expect(v).toBeCloseTo(linearToSrgb(0.25), 12);
  });

  it('два прохода — это applyPass дважды', () => {
    const random = seededRandom(11);
    const photo = randomAdjust(random);
    const look = randomAdjust(random);
    const baked = bakePipeline({ photo, look });
    for (const c of randomColors(200, 12)) {
      const expected = applyPass(applyPass(c, bakeAdjust(photo)), bakeAdjust(look));
      expect(applyPipeline(c, { photo, look })).toEqual(expected);
      expect(applyBaked(c, baked)).toEqual(expected);
    }
  });

  it('баланс белого теплеет и сохраняет яркость серого', () => {
    const out = applyPipeline(gray(0.5), { photo: adjust({ temp: 50 }) });
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[1]).toBeGreaterThan(out[2]);
    expect(lum(decodeSrgb(out))).toBeCloseTo(lum(decodeSrgb(gray(0.5))), 12);
  });

  it('тональная кривая сохраняет соотношение каналов в линейном свете', () => {
    const c: Rgb = [0.6, 0.4, 0.3];
    const out = decodeSrgb(applyPipeline(c, { photo: adjust({ shadows: 50, contrast: 30 }) }));
    const lin = decodeSrgb(c);
    expect(out[0] / out[1]).toBeCloseTo(lin[0] / lin[1], 10);
    expect(out[2] / out[1]).toBeCloseTo(lin[2] / lin[1], 10);
  });

  it('кривые работают в гамма-кодированном sRGB', () => {
    const master = createAdjust();
    master.curves.master = [
      [0, 0],
      [0.5, 0.6],
      [1, 1],
    ];
    for (const v of applyPipeline(gray(0.5), { photo: master })) expect(v).toBeCloseTo(0.6, 5);

    const red = createAdjust();
    red.curves.r = [
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ];
    const out = applyPipeline(gray(0.5), { photo: red });
    expect(out[0]).toBeCloseTo(0.7, 5);
    // Тождественные каналы идут через ту же таблицу: отличие — только округление float32.
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });

  it('насыщенность −100 делает цвет серым той же светлоты OKLab', () => {
    const out = applyPipeline([0.8, 0.3, 0.2], { photo: adjust({ saturation: -100 }) });
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-6);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(1e-6);
  });

  it('при любых параметрах результат конечен и лежит в 0..1', () => {
    const random = seededRandom(3);
    for (let n = 0; n < 40; n++) {
      const baked = bakePipeline({ photo: randomAdjust(random), look: randomAdjust(random) });
      for (const c of randomColors(100, n)) {
        for (const v of applyBaked(c, baked)) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('processRgba8 совпадает с попиксельным применением и не трогает альфу', () => {
    const random = seededRandom(5);
    const baked = bakePipeline({ photo: randomAdjust(random) });
    const src = new Uint8ClampedArray(64 * 4).map((_, i) => (i % 4 === 3 ? 200 : Math.floor(random() * 256)));
    const out = processRgba8(src, baked);
    expect(out).toBeInstanceOf(Float32Array);
    for (let p = 0; p < 64; p++) {
      const expected = applyBaked([src[p * 4]! / 255, src[p * 4 + 1]! / 255, src[p * 4 + 2]! / 255], baked);
      for (let c = 0; c < 3; c++) expect(out[p * 4 + c]).toBeCloseTo(expected[c] ?? NaN, 6);
      expect(out[p * 4 + 3]).toBeCloseTo(200 / 255, 6);
    }
  });

  it('encode/decode вокруг шагов не копит ошибку на нейтральном проходе образа', () => {
    const photo = adjust({ exposure: 0.5 });
    const c: Rgb = [0.2, 0.5, 0.7];
    expect(applyPipeline(c, { photo, look: createAdjust() })).toEqual(applyPipeline(c, { photo }));
    expect(encodeSrgb(decodeSrgb(c)).every((v, i) => Math.abs(v - (c[i] ?? NaN)) < 1e-12)).toBe(true);
  });
});
