import { describe, expect, it } from 'vitest';
import { bakePipeline, type PipelineParams } from '@core/color/bake';
import { applyBaked } from '@core/color/pipeline';
import type { Rgb } from '@core/color/srgb';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { identityLut } from '@core/lut/lut3d';
import { checkLut, chooseLutSize, lutCheckColors, lutErrors, passesLimits, summarizeErrors } from '@core/lut/verify';
import { createAdjust } from '@core/project/defaults';
import { parityCases } from '../../golden/cases';
import { goldenImages, type GoldenImage } from '../../golden/images';
import { filmLook as film, kinkLook as kink } from '../../golden/looks';

const reference = (params: PipelineParams) => {
  const baked = bakePipeline(params);
  return (rgb: Rgb) => applyBaked(rgb, baked);
};

function imageColors(image: GoldenImage): Float64Array {
  const n = image.width * image.height;
  const colors = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) colors[i * 3 + c] = (image.data[i * 4 + c] as number) / 255;
  return colors;
}

describe('проверка по кругу', () => {
  it('набор цветов постоянный: центры ячеек 17³, 20 000 случайных, 8 рамп', () => {
    const colors = lutCheckColors(33);
    expect(colors.length).toBe((17 ** 3 + 20_000 + 8 * 256) * 3);
    expect(lutCheckColors(33)).toEqual(colors);
    // Центры ячеек решётки 33: в координатах решётки дробная часть — ровно 0.5.
    for (let i = 0; i < 17 ** 3 * 3; i++) expect(((colors[i] as number) * 32) % 1).toBe(0.5);
    expect(colors[0]).toBe(0.5 / 32);
    expect(colors[16 * 3]).toBe(31.5 / 32);
    // У маленькой решётки центр один.
    expect(lutCheckColors(2).length).toBe((1 + 20_000 + 8 * 256) * 3);
  });

  it('среднее, 99-й перцентиль по ближайшему рангу, максимум', () => {
    const errors = Float64Array.from({ length: 100 }, (_, i) => 99 - i);
    expect(summarizeErrors(errors)).toEqual({ mean: 49.5, p99: 98, max: 99, count: 100 });
    expect(passesLimits({ mean: 0.49, p99: 1.99 })).toBe(true);
    expect(passesLimits({ mean: 0.5, p99: 1 })).toBe(false);
    expect(passesLimits({ mean: 0.1, p99: 2 })).toBe(false);
  });

  it('тождество проходит без ошибки', () => {
    const check = checkLut(identityLut(33), (c) => c);
    expect(check.pass).toBe(true);
    expect(check.tetrahedral.max).toBeLessThan(1e-9);
    expect(check.trilinear.max).toBeLessThan(1e-9);
  });

  it('проверка не пустая: LUT другого образа не проходит', () => {
    const lut = bakeLut(lookPipeline({ ...createAdjust(), exposure: 0.3 }), 33);
    const check = checkLut(lut, reference(lookPipeline({ ...createAdjust(), exposure: 0.4 })));
    expect(check.pass).toBe(false);
    expect(check.tetrahedral.mean).toBeGreaterThan(0.5);
  });

  it('образ с умеренными правками проходит на 33', () => {
    const choice = chooseLutSize(lookPipeline(film()));
    expect(choice.size).toBe(33);
    expect(choice.checks[33].pass).toBe(true);
    expect(choice.checks[33].tetrahedral.p99).toBeLessThan(1);
    expect(choice.checks[65]).toBeUndefined();
  });

  it('кривая с изломом не проходит на 33 и проходит на 65', () => {
    const choice = chooseLutSize(lookPipeline(kink()));
    expect(choice.checks[33].pass).toBe(false);
    expect(choice.checks[33].tetrahedral.p99).toBeGreaterThan(2);
    expect(choice.checks[65]?.pass).toBe(true);
    expect(choice.size).toBe(65);
  });

  it('трилинейная считается отдельно: на HSL она грубее тетраэдрической', () => {
    const hsl = parityCases().find((c) => c.name === 'HSL') as { params: PipelineParams };
    const check = checkLut(bakeLut(hsl.params, 33), reference(hsl.params));
    expect(check.trilinear.mean).toBeGreaterThan(check.tetrahedral.mean * 1.5);
    expect(check.pass).toBe(passesLimits(check.tetrahedral));
  });

  // Эталонные изображения × наборы сверки шейдера: на 65 проходят все, на 33 — все, кроме этих пар.
  // Список — в журнале этапа 3а: случайные наборы во всём диапазоне ползунков и «всё сразу».
  const FAILING_AT_33 = [
    'всё сразу и образ × почти серые',
    'случайно 2 × рампы',
    'случайно 2 × шум',
    'случайно 3 × круг тонов',
    'случайно 3 × кожа',
    'случайно 3 × почти серые',
  ];

  for (const size of [33, 65]) {
    it(`эталонные изображения × наборы сверки на ${size}`, () => {
      const images = goldenImages().map((image) => ({ name: image.name, colors: imageColors(image) }));
      const failing: string[] = [];
      for (const { name, params } of parityCases()) {
        const lut = bakeLut(params, size);
        const ref = reference(params);
        for (const image of images) {
          const { errors } = lutErrors(lut, ref, image.colors, ['tetrahedral']);
          if (!passesLimits(summarizeErrors(errors[0] as Float64Array))) failing.push(`${name} × ${image.name}`);
        }
      }
      expect(failing).toEqual(size === 65 ? [] : FAILING_AT_33);
    });
  }
});
