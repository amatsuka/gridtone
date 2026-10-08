// Синтетические LUT для шага 9 (этап 3б): общие для модульных тестов, сверки шейдера и e2e.
import type { PipelineParams } from '../../src/core/color/bake';
import type { Rgb } from '../../src/core/color/srgb';
import { bakeLut, lookPipeline } from '../../src/core/lut/bake';
import { createLut, type Lut3D } from '../../src/core/lut/lut3d';
import { createAdjust } from '../../src/core/project/defaults';
import type { Adjust } from '../../src/core/project/types';
import { seededRandom } from '../core/color/helpers';
import { randomAdjust } from './cases';

/** Функция «Сепии»: тёплый монохром по яркости с затемнёнными средними и поднятыми тенями. Не перестановочна с экспозицией. */
export function sepia([r, g, b]: Rgb): Rgb {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const t = 0.08 + 0.87 * y * y;
  return [1.05 * t, 0.95 * t, 0.75 * t];
}

/** «Сепия» 17³ с TITLE — e2e пишет её в `сепия.cube`. */
export function sepiaLut(size = 17): Lut3D {
  return { ...createLut(size, sepia), title: 'Сепия' };
}

/** Запечённый из случайной коррекции во всём диапазоне ползунков. */
export function bakedRandomLut(size: number, seed: number): Lut3D {
  return bakeLut(lookPipeline(randomAdjust(seededRandom(seed))), size);
}

/** Перестановка каналов с нелинейностью, выходом за 0..1 и доменом −0.1…1.2. */
export function swapLut(): Lut3D {
  return createLut(7, ([r, g, b]) => [1.3 * b * b - 0.15, r, 1.25 * g - 0.1], { min: [-0.1, -0.1, -0.1], max: [1.2, 1.2, 1.2] });
}

/** Размер 2: восемь узлов со случайными значениями в −0.5…1.5 — на нём видна любая ошибка выбора тетраэдра. */
export function tinyLut(seed = 11): Lut3D {
  const random = seededRandom(seed);
  return createLut(2, () => [random() * 2 - 0.5, random() * 2 - 0.5, random() * 2 - 0.5]);
}

/** Размер 65: гладкая, но далёкая от тождества функция. */
export function largeLut(): Lut3D {
  return createLut(65, ([r, g, b]) => [
    0.5 + 0.5 * Math.sin(6 * r + 2 * g),
    g * g * (1.2 - 0.4 * b),
    0.5 + 0.45 * Math.cos(5 * b - 3 * r),
  ]);
}

export interface LutParityCase {
  name: string;
  /** Без LUT: его тест передаёт отдельно, по id. */
  params: PipelineParams;
  lutId: string;
}

/** Синтетические LUT сверки шейдера с core: id → LUT. */
export function parityLuts(): Record<string, Lut3D> {
  return { baked17: bakedRandomLut(17, 31), swap: swapLut(), tiny: tinyLut(), large: largeLut() };
}

const LUT_NAMES: Record<string, string> = {
  baked17: 'LUT 17 из случайной коррекции',
  swap: 'LUT перестановка, домен −0.1…1.2',
  tiny: 'LUT размера 2',
  large: 'LUT размера 65',
};

/** Каждый LUT без коррекции образа и с ней (и с поправкой фото). */
export function lutParityCases(): LutParityCase[] {
  const random = seededRandom(91);
  const cases: LutParityCase[] = [];
  for (const lutId of Object.keys(LUT_NAMES)) {
    const look: Adjust = randomAdjust(random);
    const photo: Adjust = { ...createAdjust(), exposure: 0.3, contrast: 20, saturation: 15 };
    cases.push({ name: `${LUT_NAMES[lutId]}`, params: { photo: createAdjust() }, lutId });
    cases.push({ name: `${LUT_NAMES[lutId]} и образ`, params: { photo, look }, lutId });
  }
  return cases;
}
