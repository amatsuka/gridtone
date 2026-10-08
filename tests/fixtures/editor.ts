// «Редактор» для проверок калибровочной карты (этап 3в): тест сам накладывает LUT на карту, как
// корректирующий слой Photoshop, и сохраняет результат. Настоящие редакторы — ручной чек-лист.
import sharp, { type Sharp } from 'sharp';
import type { Rgb } from '../../src/core/color/srgb';
import { decodeSrgb, encodeSrgbClamped } from '../../src/core/color/transfer';
import { sampleLut, type Lut3D } from '../../src/core/lut/lut3d';

export interface RawImage {
  width: number;
  height: number;
  /** RGB 8 бит. */
  data: Buffer;
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Картинка из файла, RGB 8 бит в sRGB. */
export async function readRgb(file: string): Promise<RawImage> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** f к каждой точке, выход срезается в 0..1 и округляется до 8 бит. Цветов в карте немного: результат запоминается. */
export function editRgb(image: RawImage, f: (c: Rgb) => Rgb): RawImage {
  const memo = new Map<number, Rgb>();
  const data = Buffer.alloc(image.data.length);
  for (let i = 0; i < data.length; i += 3) {
    const key = (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
    let out = memo.get(key);
    if (!out) {
      out = f([image.data[i]! / 255, image.data[i + 1]! / 255, image.data[i + 2]! / 255]).map((v) => Math.round(clamp01(v) * 255)) as Rgb;
      memo.set(key, out);
    }
    data[i] = out[0];
    data[i + 1] = out[1];
    data[i + 2] = out[2];
  }
  return { ...image, data };
}

/** LUT тетраэдрической интерполяцией, как Color Lookup в Photoshop. */
export const viaLut =
  (lut: Lut3D) =>
  (c: Rgb): Rgb =>
    sampleLut(lut, c, 'tetrahedral').map(clamp01) as Rgb;

/** Экспозиция +ev в линейном свете: «базовая версия» не та, что в Gridtone. */
export const brighten =
  (ev: number) =>
  (c: Rgb): Rgb =>
    encodeSrgbClamped(decodeSrgb(c).map((v) => v * 2 ** ev) as Rgb);

export function toSharp(image: RawImage): Sharp {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } });
}
