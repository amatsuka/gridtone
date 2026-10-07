// Окно сетки из прокси для метрик (docs/decisions/0012-view-modes.md): та же геометрия, что у плитки
// в шейдере (src/core/project/crop.ts), но уменьшенная до размера метрик. Каждая точка — среднее
// supersample² билинейных выборок по своей ячейке, так уменьшение не даёт муара.
// Значения усредняются в гамма-кодированном sRGB, как фильтрация 8-битной текстуры на GPU.
import { applyAffine, type Affine } from '../project/crop';

/** Изображение RGBA 8 бит, строки сверху вниз. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * transform — точка плитки (0..1, начало слева сверху) → нормированные координаты фото, как
 * gridWindowTransform. Результат — RGB float 0..1, width × height точек, строки сверху вниз.
 * За краем фото берётся крайний пиксель.
 */
export function sampleWindow(image: RgbaImage, transform: Affine, width: number, height: number, supersample = 3): Float32Array {
  const out = new Float32Array(width * height * 3);
  const n = Math.max(1, Math.floor(supersample));
  const weight = 1 / (n * n);
  const rgb = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < n; j++) {
        const v = (y + (j + 0.5) / n) / height;
        for (let i = 0; i < n; i++) {
          const u = (x + (i + 0.5) / n) / width;
          const [s, t] = applyAffine(transform, u, v);
          bilinear(image, s * image.width - 0.5, t * image.height - 0.5, rgb);
          r += rgb[0] as number;
          g += rgb[1] as number;
          b += rgb[2] as number;
        }
      }
      const o = (y * width + x) * 3;
      out[o] = (r * weight) / 255;
      out[o + 1] = (g * weight) / 255;
      out[o + 2] = (b * weight) / 255;
    }
  }
  return out;
}

/** Билинейная выборка в пиксельных координатах (центр пикселя — целое число), края повторяются. */
function bilinear(image: RgbaImage, px: number, py: number, out: number[]): void {
  const { width, height, data } = image;
  const fx = Math.min(width - 1, Math.max(0, px));
  const fy = Math.min(height - 1, Math.max(0, py));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const a = data[i00 + c] as number;
    const b = data[i10 + c] as number;
    const top = a + (b - a) * tx;
    const d = data[i01 + c] as number;
    const e = data[i11 + c] as number;
    const bottom = d + (e - d) * tx;
    out[c] = top + (bottom - top) * ty;
  }
}
