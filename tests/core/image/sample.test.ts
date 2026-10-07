import { describe, expect, it } from 'vitest';
import { sampleWindow, type RgbaImage } from '@core/image/sample';
import { gridWindowTransform, type Affine } from '@core/project/crop';
import { createCrop } from '@core/project/defaults';

/** Синтетическое изображение RGBA 8 бит. */
function image(width: number, height: number, color: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = color(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];

function pixel(out: Float32Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 3;
  return [out[i] as number, out[i + 1] as number, out[i + 2] as number];
}

describe('окно сетки из прокси', () => {
  it('тождественное окно того же размера без подвыборки возвращает пиксели как есть', () => {
    const src = image(7, 5, (x, y) => [x * 30, y * 50, (x * y) % 256]);
    const out = sampleWindow(src, IDENTITY, 7, 5, 1);
    expect(out).toHaveLength(7 * 5 * 3);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        const expected = [x * 30, y * 50, (x * y) % 256].map((v) => v / 255);
        pixel(out, 7, x, y).forEach((v, c) => expect(v).toBeCloseTo(expected[c] as number, 6));
      }
    }
  });

  it('однотонное изображение даёт тот же цвет при любом окне и подвыборке', () => {
    const src = image(64, 48, () => [200, 100, 30]);
    const out = sampleWindow(src, [0.3, 0.1, 0.2, -0.1, 0.4, 0.5], 16, 20, 3);
    for (let i = 0; i < out.length; i += 3) {
      expect(out[i]).toBeCloseTo(200 / 255, 6);
      expect(out[i + 1]).toBeCloseTo(100 / 255, 6);
      expect(out[i + 2]).toBeCloseTo(30 / 255, 6);
    }
  });

  it('уменьшение усредняет: шахматка 1 × 1 становится серой', () => {
    const src = image(64, 64, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
    const out = sampleWindow(src, IDENTITY, 16, 16, 4);
    for (const v of out) expect(v).toBeCloseTo(0.5, 1);
  });

  it('окно правой половины видит только правую половину', () => {
    const src = image(40, 20, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
    // Плитка (u, v) → фото (0.5 + 0.5u, v).
    const out = sampleWindow(src, [0.5, 0, 0.5, 0, 1, 0], 10, 10, 3);
    // Билинейная выборка у самого шва задевает соседний пиксель: крайний левый столбец пропускаем.
    for (let y = 0; y < 10; y++) {
      for (let x = 1; x < 10; x++) expect(pixel(out, 10, x, y)).toEqual([0, 0, 1]);
    }
  });

  it('окно по кадру из crop.ts: альбомное фото → центральное окно 3:4', () => {
    // Слева и справа полосы по 1/8 ширины другого цвета: кадр 3:4 в 4:3 их не захватывает.
    const src = image(160, 120, (x) => (x < 20 || x >= 140 ? [0, 255, 0] : [255, 255, 255]));
    const transform = gridWindowTransform(160, 120, createCrop(), '3:4');
    const out = sampleWindow(src, transform, 24, 32, 3);
    for (let y = 0; y < 32; y++) {
      for (let x = 1; x < 23; x++) expect(pixel(out, 24, x, y)).toEqual([1, 1, 1]);
    }
  });

  it('за краем фото берётся крайний пиксель', () => {
    const src = image(4, 4, () => [10, 20, 30]);
    const out = sampleWindow(src, [2, 0, -0.5, 0, 2, -0.5], 4, 4, 2);
    for (let i = 0; i < out.length; i += 3) expect(out[i]).toBeCloseTo(10 / 255, 6);
  });
});
