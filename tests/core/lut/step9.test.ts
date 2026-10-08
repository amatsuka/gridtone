// Шаг 9 конвейера (docs/decisions/0015-lut-import.md): импортированный LUT образа — последний в проходе
// образа, тетраэдрическая интерполяция, вход вне домена срезается к краю, выход — в 0..1.
import { describe, expect, it } from 'vitest';
import { bakeAdjust, bakePipeline } from '@core/color/bake';
import { applyBaked, applyLutStep, applyPass, applyPipeline } from '@core/color/pipeline';
import type { Rgb } from '@core/color/srgb';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { createLut, identityLut, sampleLut } from '@core/lut/lut3d';
import { chooseLutSize } from '@core/lut/verify';
import { createAdjust } from '@core/project/defaults';
import { randomAdjust } from '../../golden/cases';
import { bakedRandomLut, sepia, sepiaLut, swapLut, tinyLut } from '../../golden/luts';
import { colorLattice, randomColors, seededRandom } from '../color/helpers';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamped = (c: Rgb): Rgb => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];

describe('шаг 9 — импортированный LUT образа', () => {
  it('без LUT конвейер прежний бит в бит', () => {
    const random = seededRandom(3);
    const photo = randomAdjust(random);
    const look = randomAdjust(random);
    const withField = bakePipeline({ photo, look, lut: undefined });
    for (const c of randomColors(500, 4)) {
      expect(applyBaked(c, withField)).toEqual(applyPass(applyPass(c, bakeAdjust(photo)), bakeAdjust(look)));
    }
    expect(withField.lut).toBeNull();
  });

  it('последний в проходе образа: LUT(образ(поправка(c))), выход срезан в 0..1', () => {
    const random = seededRandom(5);
    const photo = randomAdjust(random);
    const look = randomAdjust(random);
    const lut = swapLut();
    const baked = bakePipeline({ photo, look, lut });
    expect(baked.lut).toBe(lut);
    for (const c of randomColors(2000, 6)) {
      const expected = clamped(sampleLut(lut, applyPass(applyPass(c, bakeAdjust(photo)), bakeAdjust(look)), 'tetrahedral'));
      expect(applyBaked(c, baked)).toEqual(expected);
    }
  });

  it('не перестановочен с экспозицией образа: шаг 9 идёт после неё', () => {
    const look = { ...createAdjust(), exposure: 0.5 };
    const lut = sepiaLut();
    const baked = bakePipeline({ photo: createAdjust(), look, lut });
    const gray: Rgb = [0.75, 0.75, 0.75];
    const lutThenExposure = applyPass(clamped(sampleLut(lut, gray)), bakeAdjust(look));
    const exposureThenLut = clamped(sampleLut(lut, applyPass(gray, bakeAdjust(look))));
    expect(applyBaked(gray, baked)).toEqual(exposureThenLut);
    expect(Math.abs(exposureThenLut[0] - lutThenExposure[0])).toBeGreaterThan(0.05);
  });

  it('LUT без коррекции образа: проход образа нейтрален, LUT применяется', () => {
    const lut = sepiaLut();
    const baked = bakePipeline({ photo: createAdjust(), lut });
    for (const c of colorLattice(9)) expect(applyBaked(c, baked)).toEqual(clamped(sampleLut(lut, c)));
    // В узлах 17³ «Сепия» — сама функция.
    const node: Rgb = [0.25, 0.5, 0.75];
    const out = applyBaked(node, baked);
    sepia(node).forEach((v, i) => expect(out[i]).toBeCloseTo(v, 12));
  });

  it('тождественный LUT с нейтральной коррекцией — тождество', () => {
    const baked = bakePipeline({ photo: createAdjust(), look: createAdjust(), lut: identityLut(5) });
    for (const c of randomColors(1000, 7)) {
      const out = applyBaked(c, baked);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i] as number, 12);
    }
  });

  it('домен: вход вне DOMAIN_MIN…DOMAIN_MAX срезается к краю', () => {
    // На домене 0.2…0.8 LUT — тождество; всё, что ниже 0.2 или выше 0.8, получает значение края.
    const lut = createLut(5, (c) => c, { min: [0.2, 0.2, 0.2], max: [0.8, 0.8, 0.8] });
    const out = applyLutStep([0.1, 0.5, 0.95], lut);
    expect(out[0]).toBeCloseTo(0.2, 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
    expect(out[2]).toBeCloseTo(0.8, 12);
    // Домен шире 0..1: вход 0 и 1 попадают внутрь решётки, а не на её края.
    const wide = swapLut();
    expect(applyLutStep([0, 0, 0], wide)).toEqual(clamped(sampleLut(wide, [0, 0, 0])));
    expect(sampleLut(wide, [0, 0, 0])).not.toEqual(sampleLut(wide, [-0.1, -0.1, -0.1]));
  });

  it('выход за 0..1 срезается: шаг 9 отдаёт sRGB 0..1, как шаги 5 и 8', () => {
    const lut = tinyLut();
    let outside = 0;
    for (const c of randomColors(2000, 8)) {
      const raw = sampleLut(lut, c);
      if (raw.some((v) => v < 0 || v > 1)) outside++;
      const out = applyLutStep(c, lut);
      expect(out).toEqual(clamped(raw));
    }
    // Тест не пустой: часть выходов LUT действительно за пределами 0..1.
    expect(outside).toBeGreaterThan(100);
  });

  it('applyPipeline принимает LUT так же, как bakePipeline', () => {
    const lut = bakedRandomLut(9, 12);
    const params = { photo: randomAdjust(seededRandom(13)), lut };
    for (const c of randomColors(200, 14)) expect(applyPipeline(c, params)).toEqual(applyBaked(c, bakePipeline(params)));
  });
});

describe('LUT образа в запекании и проверке по кругу', () => {
  it('lookPipeline передаёт LUT образа; узлы запечённой решётки бит в бит равны applyBaked', () => {
    const lut = sepiaLut();
    const look = { ...createAdjust(), exposure: 0.2, contrast: 15 };
    const params = lookPipeline(look, lut);
    expect(params.lut).toBe(lut);
    expect(lookPipeline(look).lut).toBeUndefined();
    const baked = bakePipeline(params);
    const size = 9;
    const exported = bakeLut(params, size);
    for (const c of colorLattice(size)) {
      expect(sampleLut(exported, c)).toEqual(applyBaked(c, baked));
    }
  });

  it('«Сепия» 17³ под образом проходит проверку на 33', () => {
    const choice = chooseLutSize(lookPipeline({ ...createAdjust(), exposure: 0.5 }, sepiaLut()));
    expect(choice.size).toBe(33);
    expect(choice.checks[33].pass).toBe(true);
  });
});
