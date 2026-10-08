import { describe, expect, it } from 'vitest';
import { sampleWindow, supersampleFor, windowScale, type RgbaImage } from '@core/image/sample';
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

/** Синтетическое изображение RGB 8 бит без альфы — так его отдаёт sharp после flatten. */
function rgbImage(width: number, height: number, color: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 3);
  }
  return { width, height, data, channels: 3 };
}

/** Детерминированный «шум» 0..255. */
const noise = (x: number, y: number, c: number) => (x * 73 + y * 151 + c * 37 + ((x * y) % 17) * 11) % 256;

describe('окно поста из оригинала (этап 3г)', () => {
  it('RGB без альфы: тождественное окно того же размера возвращает точки бит в бит', () => {
    const src = rgbImage(9, 6, (x, y) => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)]);
    expect(supersampleFor(windowScale(IDENTITY, 9, 6, 9, 6))).toBe(1);
    const out = sampleWindow(src, IDENTITY, 9, 6, 1);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 9; x++) expect(pixel(out, 9, x, y)).toEqual([0, 1, 2].map((c) => Math.fround(noise(x, y, c) / 255)));
    }
  });

  it('уменьшение в целое число раз — точное среднее по ячейке', () => {
    for (const k of [2, 3, 4]) {
      const src = rgbImage(6 * k, 4 * k, (x, y) => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)]);
      const n = supersampleFor(windowScale(IDENTITY, src.width, src.height, 6, 4));
      expect(n).toBe(k);
      const out = sampleWindow(src, IDENTITY, 6, 4, n);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 6; x++) {
          const mean = [0, 1, 2].map((c) => {
            let sum = 0;
            for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) sum += noise(x * k + i, y * k + j, c);
            return sum / (k * k) / 255;
          });
          pixel(out, 6, x, y).forEach((v, c) => expect(v).toBeCloseTo(mean[c] as number, 6));
        }
      }
    }
  });

  it('поворот на 90°: окно видит фото повёрнутым, точка в точку', () => {
    const src = rgbImage(5, 3, (x, y) => [x * 50, y * 100, 7]);
    // Плитка (u, v) → фото (v, 1 − u): плитка 3 × 5 показывает фото, повёрнутое на 90° против часовой.
    const turn: Affine = [0, 1, 0, -1, 0, 1];
    expect(supersampleFor(windowScale(turn, 5, 3, 3, 5))).toBe(1);
    const out = sampleWindow(src, turn, 3, 5, 1);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) expect(pixel(out, 3, x, y)).toEqual([y * 50, (2 - x) * 100, 7].map((v) => Math.fround(v / 255)));
    }
  });

  it('масштаб окна — сторона ячейки выхода в точках изображения, по большей оси', () => {
    expect(windowScale(IDENTITY, 100, 100, 50, 50)).toBe(2);
    expect(windowScale(IDENTITY, 100, 100, 200, 200)).toBe(0.5);
    // Окно — правая половина: по ширине 50 точек на 10, по высоте 100 на 10.
    expect(windowScale([0.5, 0, 0.5, 0, 1, 0], 100, 100, 10, 10)).toBe(10);
    // Поворот на 45° не меняет длину стороны.
    const c = Math.SQRT1_2;
    expect(windowScale([c, -c, 0.5, c, c, 0], 100, 100, 25, 25)).toBeCloseTo(4, 12);
    expect(supersampleFor(0.3)).toBe(1);
    expect(supersampleFor(2.004)).toBe(2);
    expect(supersampleFor(2.5)).toBe(3);
    expect(supersampleFor(1000)).toBe(8);
  });
});
