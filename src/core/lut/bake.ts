// Запекание LUT (docs/spec.md, «Модуль 2», «Запекание»): эталонный конвейер семплируется в узлах решётки.
// Шейдер не нужен: CPU-версия точнее и уже сверена с ним (tests/e2e/shader-parity.spec.ts).
import { bakePipeline, type PipelineParams } from '../color/bake';
import { applyBaked } from '../color/pipeline';
import { createAdjust } from '../project/defaults';
import type { Adjust } from '../project/types';
import { createLut, type Lut3D } from './lut3d';

/** Узлы size³ на домене 0..1: в каждом — applyBaked от его цвета. Для 65³ — около секунды. */
export function bakeLut(params: PipelineParams, size: number, title?: string): Lut3D {
  const baked = bakePipeline(params);
  const lut = createLut(size, (rgb) => applyBaked(rgb, baked));
  return title === undefined ? lut : { ...lut, title };
}

/**
 * Параметры LUT образа: его проход поверх нейтральной поправки фото, вместе с импортированным LUT
 * образа (шаг 9). Поправка фото выравнивает конкретный кадр и в LUT образа не входит: это делает
 * редактор до LUT (spec, «Пределы»).
 */
export function lookPipeline(look: Adjust, lut?: Lut3D): PipelineParams {
  return lut ? { photo: createAdjust(), look, lut } : { photo: createAdjust(), look };
}

/**
 * Параметры поста — то, что видно на его плитке: поправка фото, образ и LUT образа (шаг 9). Так
 * считаются пост, плитка `Сетка.png` и LUT на каждый пост (docs/decisions/0017-post-export.md).
 */
export function postPipeline(photo: Adjust, look?: Adjust, lut?: Lut3D): PipelineParams {
  if (!look) return { photo };
  return lut ? { photo, look, lut } : { photo, look };
}
