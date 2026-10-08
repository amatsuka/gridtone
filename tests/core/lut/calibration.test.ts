import { describe, expect, it } from 'vitest';
import { bakePipeline, type PipelineParams } from '@core/color/bake';
import { deltaE2000, srgbToCielab } from '@core/color/deltaE';
import { applyBaked } from '@core/color/pipeline';
import type { Rgb } from '@core/color/srgb';
import { decodeSrgb, encodeSrgbClamped } from '@core/color/transfer';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import {
  CARD_HEIGHT,
  CARD_LIMITS,
  CARD_WIDTH,
  CARD_WORST_COUNT,
  cardGeometry,
  cardLayout,
  checkCard,
  diagnoseCard,
  measureCard,
  patchSource,
  renderCard,
  type CardImage,
  type CardReport,
} from '@core/lut/calibration';
import { sampleLut, type Lut3D } from '@core/lut/lut3d';
import { mulberry32 } from '@core/random';
import { createAdjust } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';
import { filmLook } from '../../golden/looks';
import { sepiaLut } from '../../golden/luts';

type Rect = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * «Редактор» на CPU: f к каждому пикселю карты, выход в 8 бит. Цветов в карте немного, поэтому
 * результат запоминается по цвету. noise — шум ±noise из 255 на канал, как у JPEG.
 */
function edit(image: CardImage, f: (c: Rgb) => Rgb, noise = 0, seed = 7): CardImage {
  const memo = new Map<number, Rgb>();
  const random = mulberry32(seed);
  const { width, height, channels } = image;
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < image.data.length; i += channels, o += 3) {
    const r = image.data[i] as number;
    const g = image.data[i + 1] as number;
    const b = image.data[i + 2] as number;
    const key = (r << 16) | (g << 8) | b;
    let out = memo.get(key);
    if (!out) {
      out = f([r / 255, g / 255, b / 255]).map((v) => clamp01(v) * 255) as Rgb;
      memo.set(key, out);
    }
    for (let c = 0; c < 3; c++) {
      const jitter = noise === 0 ? 0 : Math.round((random() * 2 - 1) * noise);
      data[o + c] = Math.min(255, Math.max(0, Math.round((out[c] as number) + jitter)));
    }
  }
  return { width, height, channels: 3, data };
}

/** Уменьшение вдвое средним 2 × 2, как у простого редактора. */
function halve(image: CardImage): CardImage {
  const width = Math.floor(image.width / 2);
  const height = Math.floor(image.height / 2);
  const { channels } = image;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          sum += image.data[((2 * y + dy) * image.width + 2 * x + dx) * channels + c] as number;
        }
        data[(y * width + x) * 3 + c] = Math.round(sum / 4);
      }
    }
  }
  return { width, height, channels: 3, data };
}

/** Обрезка: оставить левую часть шириной width. */
function cropLeft(image: CardImage, width: number): CardImage {
  const { channels } = image;
  const data = new Uint8Array(width * image.height * 3);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = image.data[(y * image.width + x) * channels + c] as number;
    }
  }
  return { width, height: image.height, channels: 3, data };
}

const pipeline = (params: PipelineParams) => {
  const baked = bakePipeline(params);
  return (c: Rgb) => applyBaked(c, baked);
};

/** LUT 33 образа, применённый тетраэдрической интерполяцией, как в Photoshop. */
const viaLut = (lut: Lut3D) => (c: Rgb) => sampleLut(lut, c, 'tetrahedral');

/** Экспозиция +ev в линейном свете — «базовая версия» другая, чем у Gridtone. */
const brighten = (ev: number) => (c: Rgb) => encodeSrgbClamped(decodeSrgb(c).map((v) => v * 2 ** ev) as Rgb);

function report(image: CardImage, params: PipelineParams): Exclude<CardReport, { verdict: 'geometry' }> {
  const result = checkCard(image, params);
  if (result.verdict === 'geometry') throw new Error(`геометрия: ${result.problem}`);
  return result;
}

const card = renderCard();
const toCardImage = (): CardImage => ({ width: card.width, height: card.height, channels: 4, data: card.data });

describe('калибровочная карта: раскладка', () => {
  const layout = cardLayout();
  const bounds: Rect = { x: 0, y: 0, w: CARD_WIDTH, h: CARD_HEIGHT };

  it('около 150 патчей; не пересекаются, внутри карты; поле замера — центральная половина', () => {
    expect([layout.width, layout.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect(layout.patches.length).toBeGreaterThanOrEqual(140);
    expect(layout.patches.length).toBeLessThanOrEqual(180);
    for (const [i, a] of layout.patches.entries()) {
      expect(inside(a.rect, bounds)).toBe(true);
      expect(a.field).toEqual({ x: a.rect.x + a.rect.w / 4, y: a.rect.y + a.rect.h / 4, w: a.rect.w / 2, h: a.rect.h / 2 });
      expect(inside(a.field, a.rect)).toBe(true);
      for (const b of layout.patches.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
      for (const g of layout.gradients) expect(overlaps(a.rect, g.rect)).toBe(false);
    }
    for (const g of layout.gradients) expect(inside(g.rect, bounds)).toBe(true);
    // Карта не квадратная и далека от 3:4 и 4:5: повёрнутая на 90° не пройдёт проверку пропорций.
    expect(CARD_WIDTH / CARD_HEIGHT).toBeGreaterThan(1.5);
  });

  it('состав: серая шкала 0…255, круг тонов на трёх L, почти серые, кожа, край охвата; цвета не повторяются', () => {
    const count = (group: string) => layout.patches.filter((p) => p.group === group).length;
    expect(count('gray')).toBeGreaterThanOrEqual(20);
    expect(count('hue')).toBe(72);
    expect(count('neutral')).toBeGreaterThanOrEqual(8);
    expect(count('skin')).toBeGreaterThanOrEqual(8);
    expect(count('edge')).toBeGreaterThanOrEqual(24);
    const grays = layout.patches.filter((p) => p.group === 'gray').map((p) => p.rgb8);
    expect(grays[0]).toEqual([0, 0, 0]);
    expect(grays.at(-1)).toEqual([255, 255, 255]);
    for (const [r, g, b] of grays) expect(r === g && g === b).toBe(true);
    // Край охвата: один канал на нуле, другой на максимуме яркости патча.
    for (const p of layout.patches.filter((p) => p.group === 'edge')) {
      expect(Math.min(...p.rgb8)).toBe(0);
      expect(Math.max(...p.rgb8)).toBeGreaterThan(100);
    }
    const unique = new Set(layout.patches.map((p) => p.rgb8.join(',')));
    expect(unique.size).toBe(layout.patches.length);
    const labels = new Set(layout.patches.map((p) => p.label));
    expect(labels.size).toBe(layout.patches.length);
  });

  it('картинка: патч залит своим цветом, альфа 255; градиенты меняются вдоль полосы', () => {
    expect([card.width, card.height, card.data.length]).toEqual([CARD_WIDTH, CARD_HEIGHT, CARD_WIDTH * CARD_HEIGHT * 4]);
    for (const p of layout.patches) {
      for (const [x, y] of [
        [p.rect.x, p.rect.y],
        [p.rect.x + p.rect.w - 1, p.rect.y + p.rect.h - 1],
        [p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2],
      ] as const) {
        const i = (y * CARD_WIDTH + x) * 4;
        expect([card.data[i], card.data[i + 1], card.data[i + 2], card.data[i + 3]]).toEqual([...p.rgb8, 255]);
      }
    }
    for (const g of layout.gradients) {
      const y = g.rect.y + Math.floor(g.rect.h / 2);
      const at = (x: number) => Array.from(card.data.subarray((y * CARD_WIDTH + x) * 4, (y * CARD_WIDTH + x) * 4 + 3));
      expect(at(g.rect.x)).not.toEqual(at(g.rect.x + g.rect.w / 2));
    }
  });
});

describe('калибровочная карта: замер', () => {
  it('карта против себя — ΔE 0, замер равен цвету патча', () => {
    const measured = measureCard(toCardImage());
    const layout = cardLayout();
    expect(measured).toHaveLength(layout.patches.length);
    for (const [i, p] of layout.patches.entries()) expect(measured[i]).toEqual(patchSource(p));
    const r = report(toCardImage(), lookPipeline(createAdjust()));
    expect(r.models.none.max).toBe(0);
    expect(r.models.lut.max).toBe(0);
    expect(r.verdict).toBe('match');
  });

  it('градиенты и фон в замер не входят', () => {
    const layout = cardLayout();
    const data = Uint8Array.from(card.data);
    for (const g of layout.gradients) {
      for (let y = g.rect.y; y < g.rect.y + g.rect.h; y++) data.fill(17, (y * CARD_WIDTH + g.rect.x) * 4, (y * CARD_WIDTH + g.rect.x + g.rect.w) * 4);
    }
    // Край патча — за пределами поля замера: его портит ореол JPEG и уменьшение.
    for (const p of layout.patches) data.fill(0, (p.rect.y * CARD_WIDTH + p.rect.x) * 4, (p.rect.y * CARD_WIDTH + p.rect.x + p.rect.w) * 4);
    expect(measureCard({ width: CARD_WIDTH, height: CARD_HEIGHT, channels: 4, data })).toEqual(measureCard(toCardImage()));
  });

  it('шум JPEG усредняется полем замера', () => {
    const noisy = edit(toCardImage(), (c) => c, 8);
    const measured = measureCard(noisy);
    const layout = cardLayout();
    const errors = layout.patches.map((p, i) => deltaE2000(srgbToCielab(patchSource(p)), srgbToCielab(measured[i] as Rgb)));
    expect(errors.reduce((s, e) => s + e, 0) / errors.length).toBeLessThan(0.2);
    // Худший — у чёрного и белого: шум там срезается с одной стороны, и среднее смещается.
    expect(Math.max(...errors)).toBeLessThan(1);
  });

  it('карта другого размера с теми же пропорциями мерится так же', () => {
    const half = halve(toCardImage());
    expect(measureCard(half)).toEqual(measureCard(toCardImage()));
  });

  it('пропорции сверяются с точностью 1%; сильно уменьшенная карта не мерится', () => {
    expect(cardGeometry(CARD_WIDTH, CARD_HEIGHT)).toEqual({ ok: true, scaleX: 1, scaleY: 1 });
    expect(cardGeometry(900, 384)).toEqual({ ok: true, scaleX: 0.5, scaleY: 0.5 });
    expect(cardGeometry(Math.round(CARD_WIDTH * 1.009), CARD_HEIGHT).ok).toBe(true);
    expect(cardGeometry(Math.round(CARD_WIDTH * 1.02), CARD_HEIGHT)).toEqual({ ok: false, problem: 'proportions' });
    expect(cardGeometry(CARD_HEIGHT, CARD_WIDTH)).toEqual({ ok: false, problem: 'proportions' });
    expect(cardGeometry(CARD_WIDTH / 5, CARD_HEIGHT / 5)).toEqual({ ok: false, problem: 'small' });
    expect(() => measureCard({ width: 100, height: 100, channels: 3, data: new Uint8Array(30000) })).toThrow();
  });
});

describe('калибровочная карта: диагноз на синтетических редакторах', () => {
  const film = lookPipeline(filmLook());
  const filmLut = bakeLut(film, 33);
  const reference = pipeline(film);

  it('LUT в правильной точке — «совпадает», даже после уменьшения и шума', () => {
    const r = report(halve(edit(toCardImage(), viaLut(filmLut), 3)), film);
    expect(r.verdict).toBe('match');
    expect(r.models.lut.mean).toBeLessThan(CARD_LIMITS.mean);
    expect(r.models.lut.max).toBeLessThan(CARD_LIMITS.max);
    expect(r.weak).toBe(false);
  });

  it('без LUT — «LUT не применён», LUT дважды — «применён дважды»', () => {
    expect(report(edit(toCardImage(), (c) => c, 3), film).verdict).toBe('no-lut');
    const twice = viaLut(filmLut);
    expect(report(edit(toCardImage(), (c) => twice(twice(c).map(clamp01) as Rgb), 3), film).verdict).toBe('twice');
  });

  it('карта, осветлённая до LUT, — «цвет сдвинут», а не «дважды» и не «без LUT»', () => {
    const shifted = viaLut(filmLut);
    const lift = brighten(0.3);
    const r = report(edit(toCardImage(), (c) => shifted(lift(c)), 3), film);
    expect(r.verdict).toBe('shifted');
    expect(r.models.lut.mean).toBeGreaterThan(CARD_LIMITS.mean);
  });

  it('редактор меняет цвет после LUT — тоже «сдвинут»', () => {
    const lut = viaLut(filmLut);
    const r = report(edit(toCardImage(), (c) => brighten(0.15)(lut(c).map(clamp01) as Rgb)), film);
    expect(r.verdict).toBe('shifted');
  });

  it('ожидание — проход образа с его импортированным LUT (шаг 9)', () => {
    const params = lookPipeline({ ...createAdjust(), exposure: 0.2 }, sepiaLut());
    const exported = bakeLut(params, 33);
    expect(report(edit(toCardImage(), viaLut(exported)), params).verdict).toBe('match');
    // Без шага 9 ожидание другое: та же карта против одной коррекции образа не совпадает.
    expect(report(edit(toCardImage(), viaLut(exported)), lookPipeline(params.look as Adjust)).verdict).not.toBe('match');
  });

  it('слабый образ отмечается: карта не отличит LUT от его отсутствия', () => {
    const weak = lookPipeline({ ...createAdjust(), exposure: 0.02 });
    const r = report(toCardImage(), weak);
    expect(r.weak).toBe(true);
    expect(r.verdict).toBe('match');
  });

  it('худшие патчи — по убыванию ΔE, не больше восьми, с ожиданием и замером', () => {
    const lift = brighten(0.3);
    const lut = viaLut(filmLut);
    const r = report(edit(toCardImage(), (c) => lut(lift(c))), film);
    expect(r.worst).toHaveLength(CARD_WORST_COUNT);
    for (let i = 1; i < r.worst.length; i++) expect(r.worst[i - 1]!.deltaE).toBeGreaterThanOrEqual(r.worst[i]!.deltaE);
    expect(r.worst[0]!.deltaE).toBe(r.models.lut.max);
    const layout = cardLayout();
    for (const w of r.worst) {
      const patch = layout.patches[w.index]!;
      expect(w.label).toBe(patch.label);
      expect(w.source).toEqual(patchSource(patch));
      expect(w.expected).toEqual(reference(patchSource(patch)));
      expect(w.deltaE).toBeCloseTo(deltaE2000(srgbToCielab(w.expected), srgbToCielab(w.measured)), 12);
    }
  });

  it('диагноз по замеру напрямую: модели и пороги', () => {
    const sources = cardLayout().patches.map(patchSource);
    expect(diagnoseCard(sources, film).verdict).toBe('no-lut');
    expect(diagnoseCard(sources.map(reference), film).verdict).toBe('match');
    expect(diagnoseCard(sources.map((c) => reference(reference(c))), film).verdict).toBe('twice');
    expect(diagnoseCard(sources.map(reference), film).models.lut.max).toBe(0);
    expect(() => diagnoseCard(sources.slice(1), film)).toThrow();
  });
});

describe('калибровочная карта: геометрия в отчёте', () => {
  it('обрезанная или повёрнутая карта — без замера, с причиной', () => {
    const cropped = cropLeft(toCardImage(), Math.round(CARD_WIDTH * 0.9));
    expect(checkCard(cropped, lookPipeline(filmLook()))).toEqual({
      verdict: 'geometry',
      problem: 'proportions',
      width: cropped.width,
      height: cropped.height,
    });
    const tiny = { width: 360, height: 154, channels: 3, data: new Uint8Array(360 * 154 * 3) };
    expect(checkCard(tiny, lookPipeline(filmLook()))).toMatchObject({ verdict: 'geometry', problem: 'small' });
  });
});
