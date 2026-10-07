// Эталонный цветовой конвейер — docs/spec.md, «Модуль 1», «Конвейер».
// Шейдер src/renderer/gl/pipeline.frag.glsl повторяет те же шаги в том же порядке;
// их совпадение проверяет tests/e2e/shader-parity.spec.ts. Меняются они только вместе.
//
//  1. sRGB → линейный.
//  2. Баланс белого.
//  3. Экспозиция.
//  4. Тональная кривая.
//  5. Линейный → sRGB, срез в 0..1.
//  6. Кривые: общая, затем R, G, B.
//  7. HSL и круги в OKLCH.
//  8. Сочность и насыщенность.
//  (9. Импортированный LUT — этап 3.)
//
// Шаги 2–8 выполняются дважды: с поправкой фото, затем с образом.
import { bakePipeline, CURVE_TABLE_SIZE, type BakedAdjust, type BakedPipeline, type PipelineParams } from './bake';
import { applyChroma } from './chroma';
import { applyGrading } from './grading';
import { applyHsl } from './hsl';
import { sampleTable } from './math';
import { linearSrgbToOklab, oklabToLinearSrgb, oklabToOklch, oklchToOklab } from './oklab';
import type { Rgb } from './srgb';
import { applyTone } from './tone';
import { decodeSrgb, encodeSrgbClamped } from './transfer';

export type { PipelineParams } from './bake';

/** Один проход: шаги 1–8 с одним набором параметров. Вход и выход — sRGB 0..1. */
export function applyPass(rgb: Rgb, baked: BakedAdjust): Rgb {
  let c: Rgb = [rgb[0], rgb[1], rgb[2]];

  const { linear, curves, color } = baked;
  if (linear) {
    const lin = decodeSrgb(c);
    const k0 = linear.wb[0] * linear.exposure;
    const k1 = linear.wb[1] * linear.exposure;
    const k2 = linear.wb[2] * linear.exposure;
    let scaled: Rgb = [lin[0] * k0, lin[1] * k1, lin[2] * k2];
    if (linear.tone) scaled = applyTone(scaled, linear.tone);
    c = encodeSrgbClamped(scaled);
  }

  if (curves) {
    c = [
      sampleTable(curves, CURVE_TABLE_SIZE, 4, 0, c[0]),
      sampleTable(curves, CURVE_TABLE_SIZE, 4, 1, c[1]),
      sampleTable(curves, CURVE_TABLE_SIZE, 4, 2, c[2]),
    ];
  }

  if (color) {
    let lab = linearSrgbToOklab(decodeSrgb(c));
    if (color.hsl) lab = oklchToOklab(applyHsl(oklabToOklch(lab), color.hsl));
    if (color.grading) lab = applyGrading(lab, color.grading);
    if (color.vibrance !== 0 || color.saturation !== 0) {
      lab = oklchToOklab(applyChroma(oklabToOklch(lab), color.vibrance, color.saturation));
    }
    c = encodeSrgbClamped(oklabToLinearSrgb(lab));
  }

  return c;
}

export function applyBaked(rgb: Rgb, baked: BakedPipeline): Rgb {
  const photo = applyPass(rgb, baked.photo);
  return baked.look ? applyPass(photo, baked.look) : photo;
}

/** Удобная форма для единичных цветов. Для изображений подготовьте параметры один раз: bakePipeline. */
export function applyPipeline(rgb: Rgb, params: PipelineParams): Rgb {
  return applyBaked(rgb, bakePipeline(params));
}

/** Изображение RGBA 8 бит → RGBA float 0..1. Альфа переносится как есть. */
export function processRgba8(src: Uint8Array | Uint8ClampedArray, baked: BakedPipeline): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i + 3 < src.length; i += 4) {
    const [r, g, b] = applyBaked([(src[i] as number) / 255, (src[i + 1] as number) / 255, (src[i + 2] as number) / 255], baked);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = (src[i + 3] as number) / 255;
  }
  return out;
}
