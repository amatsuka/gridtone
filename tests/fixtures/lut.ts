// Чтение экспортированных LUT в тестах: так их видит «редактор» — тест, применяющий файл моделью core.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { parseCube } from '../../src/core/lut/cube';
import { haldToLut } from '../../src/core/lut/hald';
import type { Lut3D } from '../../src/core/lut/lut3d';

export async function readCube(file: string): Promise<Lut3D> {
  return parseCube(await readFile(file, 'utf8'));
}

/** PNG HaldCLUT как есть, 16 бит. Без toColourspace('rgb16') sharp отдал бы 8 бит, даже с depth: 'ushort'. */
export async function readHald(file: string): Promise<{ lut: Lut3D; depth: string; hasProfile: boolean; width: number; height: number }> {
  const meta = await sharp(file).metadata();
  const { data, info } = await sharp(file).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const pixels = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  return {
    lut: haldToLut({ width: info.width, height: info.height, data: pixels }),
    depth: meta.depth,
    hasProfile: meta.hasProfile === true,
    width: info.width,
    height: info.height,
  };
}
