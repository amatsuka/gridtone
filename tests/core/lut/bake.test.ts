import { describe, expect, it } from 'vitest';
import { bakePipeline } from '@core/color/bake';
import { applyBaked, applyPass } from '@core/color/pipeline';
import { bakeAdjust } from '@core/color/bake';
import type { Rgb } from '@core/color/srgb';
import { bakeLut, lookPipeline, postPipeline } from '@core/lut/bake';
import { identityLut } from '@core/lut/lut3d';
import { lutIndex, sampleLut } from '@core/lut/lut3d';
import { createAdjust } from '@core/project/defaults';
import { randomAdjust } from '../../golden/cases';
import { seededRandom } from '../color/helpers';

describe('запекание LUT', () => {
  it('узлы решётки бит в бит равны applyBaked', () => {
    const random = seededRandom(5);
    const params = { photo: randomAdjust(random), look: randomAdjust(random) };
    const baked = bakePipeline(params);
    const size = 17;
    const lut = bakeLut(params, size);
    expect(lut.size).toBe(size);
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const i = lutIndex(size, r, g, b);
          const expected = applyBaked([r / (size - 1), g / (size - 1), b / (size - 1)], baked);
          expect([lut.data[i], lut.data[i + 1], lut.data[i + 2]]).toEqual(expected);
        }
  });

  it('нейтральные параметры дают тождественную решётку', () => {
    const lut = bakeLut({ photo: createAdjust() }, 9);
    for (let i = 0; i < 9 * 9 * 9; i++) {
      const [r, g, b] = [i % 9, Math.floor(i / 9) % 9, Math.floor(i / 81)];
      expect([lut.data[i * 3], lut.data[i * 3 + 1], lut.data[i * 3 + 2]]).toEqual([r / 8, g / 8, b / 8]);
    }
  });

  it('LUT образа — его проход поверх нейтральной поправки', () => {
    const look = randomAdjust(seededRandom(8));
    const params = lookPipeline(look);
    expect(params.photo).toEqual(createAdjust());
    const lut = bakeLut(params, 5, 'Плёнка');
    expect(lut.title).toBe('Плёнка');
    const pass = bakeAdjust(look);
    const node: Rgb = [0.25, 0.75, 1];
    const i = lutIndex(5, 1, 3, 4);
    expect([lut.data[i], lut.data[i + 1], lut.data[i + 2]]).toEqual(applyPass(node, pass));
  });

  it('LUT поста — связка «поправка фото + образ» с LUT образа; без образа — только поправка', () => {
    const random = seededRandom(11);
    const photo = randomAdjust(random);
    const look = randomAdjust(random);
    const lut = identityLut(3);
    expect(postPipeline(photo)).toEqual({ photo });
    expect(postPipeline(photo, look)).toEqual({ photo, look });
    expect(postPipeline(photo, look, lut)).toEqual({ photo, look, lut });
    // LUT без образа не бывает: шаг 9 — часть прохода образа.
    expect(postPipeline(photo, undefined, lut)).toEqual({ photo });
    const node: Rgb = [0.5, 0.25, 0.75];
    const i = lutIndex(5, 2, 1, 3);
    const baked = bakeLut(postPipeline(photo, look), 5);
    expect([baked.data[i], baked.data[i + 1], baked.data[i + 2]]).toEqual(applyPass(applyPass(node, bakeAdjust(photo)), bakeAdjust(look)));
  });

  it('LUT 33 повторяет конвейер между узлами с малой ошибкой', () => {
    const params = lookPipeline({ ...createAdjust(), exposure: 0.3, contrast: 30, temp: 20 });
    const baked = bakePipeline(params);
    const lut = bakeLut(params, 33);
    const random = seededRandom(9);
    for (let k = 0; k < 2000; k++) {
      const c: Rgb = [random(), random(), random()];
      const a = sampleLut(lut, c);
      const e = applyBaked(c, baked);
      for (let ch = 0; ch < 3; ch++) expect(Math.abs((a[ch] as number) - (e[ch] as number))).toBeLessThan(0.01);
    }
  });
});
