// Пиксели поста и плитки `Сетка.png` (docs/decisions/0017-post-export.md): окно по матрице crop.ts →
// конвейер core → sRGB 8 бит. Порядок тот же, что у плитки в шейдере: выборка и усреднение в
// гамма-кодированном sRGB, затем проходы поправки фото и образа и шаг 9.
import { bakePipeline, type PipelineParams } from '../color/bake';
import { applyBaked } from '../color/pipeline';
import type { Affine } from '../project/crop';
import { sampleWindow, supersampleFor, windowScale, type RgbaImage } from './sample';

/** RGB 8 бит подряд, width × height, строки сверху вниз. Выборок на точку — по масштабу окна. */
export function renderWindow(image: RgbaImage, transform: Affine, width: number, height: number, params: PipelineParams): Uint8Array {
  const n = supersampleFor(windowScale(transform, image.width, image.height, width, height));
  const rgb = sampleWindow(image, transform, width, height, n);
  const baked = bakePipeline(params);
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const c = applyBaked([rgb[i] as number, rgb[i + 1] as number, rgb[i + 2] as number], baked);
    out[i] = to8(c[0]);
    out[i + 1] = to8(c[1]);
    out[i + 2] = to8(c[2]);
  }
  return out;
}

function to8(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}
