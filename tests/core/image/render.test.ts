import { describe, expect, it } from 'vitest';
import { applyPipeline } from '@core/color/pipeline';
import type { Rgb } from '@core/color/srgb';
import { renderWindow } from '@core/image/render';
import type { RgbaImage } from '@core/image/sample';
import { feedFrameTransform, type Affine } from '@core/project/crop';
import { createAdjust, createCrop } from '@core/project/defaults';
import { filmLook } from '../../golden/looks';

function rgbImage(width: number, height: number, color: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 3);
  }
  return { width, height, data, channels: 3 };
}

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const noise = (x: number, y: number, c: number) => (x * 73 + y * 151 + c * 37) % 256;
const photo = () => ({ ...createAdjust(), exposure: 0.4, temp: -15, saturation: 20 });

describe('пост из окна оригинала', () => {
  it('без правок тождественное окно возвращает точки как есть', () => {
    const src = rgbImage(8, 5, (x, y) => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)]);
    const out = renderWindow(src, IDENTITY, 8, 5, { photo: createAdjust() });
    expect(out).toEqual(Uint8Array.from(src.data));
  });

  it('каждая точка — конвейер core от её цвета: поправка фото, затем образ', () => {
    const src = rgbImage(8, 5, (x, y) => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)]);
    const params = { photo: photo(), look: filmLook() };
    const out = renderWindow(src, IDENTITY, 8, 5, params);
    for (let i = 0; i < out.length; i += 3) {
      const c = [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!].map((v) => v / 255) as Rgb;
      const expected = applyPipeline(c, params).map((v) => Math.round(v * 255));
      // Вход в конвейер — float32 из выборки: до 1 из 255 на границе округления.
      for (let k = 0; k < 3; k++) expect(Math.abs(out[i + k]! - expected[k]!)).toBeLessThanOrEqual(1);
    }
  });

  it('однотонный оригинал любого размера даёт однотонный пост цвета core', () => {
    const color: [number, number, number] = [90, 110, 120];
    const src = rgbImage(400, 500, () => color);
    const params = { photo: createAdjust(), look: { ...createAdjust(), exposure: 1, temp: -30 } };
    const transform = feedFrameTransform(400, 500, { ...createCrop(), feed: { aspect: '4:5', cx: 0.5, cy: 0.5, zoom: 1.3, angle: 12 } });
    const out = renderWindow(src, transform, 108, 135, params);
    const expected = applyPipeline(color.map((v) => v / 255) as Rgb, params).map((v) => Math.round(v * 255));
    for (let i = 0; i < out.length; i += 3) expect([out[i], out[i + 1], out[i + 2]]).toEqual(expected);
  });

  it('уменьшение в 2 раза — среднее по ячейке 2 × 2 до конвейера', () => {
    // Полосы 0 и 255 через пиксель: уменьшенные вдвое — серые 127.5 до правок.
    const src = rgbImage(8, 8, (x) => (x % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
    const out = renderWindow(src, IDENTITY, 4, 4, { photo: createAdjust() });
    for (const v of out) expect(v).toBe(128);
  });
});
