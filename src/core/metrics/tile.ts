// Метрики плитки (docs/decisions/0012-view-modes.md, 0018-features-grid-metrics.md): окно сетки из прокси 512 →
// конвейер core → OKLab → признаки (`Features`), тон среднего и доминанта. Одна функция для воркера метрик
// и для тестов: режимы 5 и 7 берут доминанту и средние, вкладка «Анализ» — признаки целиком.
import { bakePipeline, type PipelineParams } from '../color/bake';
import { linearSrgbToOklab, oklabToLinearSrgb } from '../color/oklab';
import { applyBaked } from '../color/pipeline';
import type { Lab } from '../color/srgb';
import { decodeSrgb, encodeSrgbClamped } from '../color/transfer';
import { sampleWindow, type RgbaImage } from '../image/sample';
import { gridWindowTransform } from '../project/crop';
import type { Crop, Features, Ratio, Vec3 } from '../project/types';
import { meanHue, tileFeatures } from './features';

/** Ширина окна метрик; высота — по пропорциям сетки. Прокси 256 нет (ADR 0004), окно уменьшается из 512. */
export const METRICS_WINDOW_WIDTH = 192;

export interface TileMetrics extends Features {
  /** Тон среднего цвета (a, b), градусы 0..360; у серого 0. */
  hue: number;
  /** Главный цвет — первый в палитре. */
  dominant: Vec3;
}

export function metricsWindowSize(ratio: Ratio): [number, number] {
  return ratio === '1:1' ? [METRICS_WINDOW_WIDTH, METRICS_WINDOW_WIDTH] : [METRICS_WINDOW_WIDTH, (METRICS_WINDOW_WIDTH * 4) / 3];
}

/** Окно метрик до конвейера: RGB 0..1 подряд, metricsWindowSize точек, строки сверху вниз. */
export function windowRgb(image: RgbaImage, crop: Crop, ratio: Ratio): Float32Array {
  const [width, height] = metricsWindowSize(ratio);
  return sampleWindow(image, gridWindowTransform(image.width, image.height, crop, ratio), width, height);
}

/** Пиксели окна сетки после конвейера, в OKLab подряд (L, a, b). */
export function tileLab(image: RgbaImage, crop: Crop, ratio: Ratio, params: PipelineParams): Float32Array {
  const rgb = windowRgb(image, crop, ratio);
  const baked = bakePipeline(params);
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const c = applyBaked([rgb[i] as number, rgb[i + 1] as number, rgb[i + 2] as number], baked);
    const lab = linearSrgbToOklab(decodeSrgb(c));
    out[i] = lab[0];
    out[i + 1] = lab[1];
    out[i + 2] = lab[2];
  }
  return out;
}

export function tileMetrics(image: RgbaImage, crop: Crop, ratio: Ratio, params: PipelineParams): TileMetrics {
  const [width, height] = metricsWindowSize(ratio);
  const features = tileFeatures(tileLab(image, crop, ratio, params), width, height);
  return { ...features, hue: meanHue(features.meanA, features.meanB), dominant: features.palette[0]?.lab ?? [0, 0, 0] };
}

/** OKLab → sRGB 8 бит со срезом в охват: так доминанта заливает плитку в режиме 5. */
export function labToSrgb8(lab: Lab | Vec3): [number, number, number] {
  const [r, g, b] = encodeSrgbClamped(oklabToLinearSrgb([lab[0], lab[1], lab[2]]));
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
