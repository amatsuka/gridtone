import { describe, expect, it } from 'vitest';
import { HALD_LEVEL, haldGeometry, haldPosition, haldToLut, lutToHald } from '@core/lut/hald';
import { createLut, identityLut, lutIndex } from '@core/lut/lut3d';
import { seededRandom } from '../color/helpers';

describe('HaldCLUT', () => {
  it('уровень 8 — куб 64³ в картинке 512 × 512', () => {
    expect(HALD_LEVEL).toBe(8);
    expect(haldGeometry(8)).toEqual({ size: 64, width: 512 });
    expect(haldGeometry(4)).toEqual({ size: 16, width: 64 });
  });

  it('положение узла: R быстрее всех, строки по 512 точек', () => {
    expect(haldPosition(8, 0, 0, 0)).toEqual([0, 0]);
    expect(haldPosition(8, 63, 0, 0)).toEqual([63, 0]);
    expect(haldPosition(8, 0, 1, 0)).toEqual([64, 0]);
    expect(haldPosition(8, 0, 8, 0)).toEqual([0, 1]);
    expect(haldPosition(8, 5, 9, 0)).toEqual([69, 1]);
    expect(haldPosition(8, 0, 0, 1)).toEqual([0, 8]);
    expect(haldPosition(8, 63, 63, 63)).toEqual([511, 511]);
  });

  it('тождественный Hald равен решётке: в точке — цвет её узла, 16 бит', () => {
    const image = lutToHald(identityLut(64));
    expect(image.width).toBe(512);
    expect(image.height).toBe(512);
    expect(image.data).toBeInstanceOf(Uint16Array);
    expect(image.data.length).toBe(512 * 512 * 3);
    const random = seededRandom(3);
    for (let k = 0; k < 500; k++) {
      const [r, g, b] = [0, 0, 0].map(() => Math.floor(random() * 64)) as [number, number, number];
      const [x, y] = haldPosition(8, r, g, b);
      const p = (y * 512 + x) * 3;
      expect([image.data[p], image.data[p + 1], image.data[p + 2]]).toEqual(
        [r, g, b].map((v) => Math.round((v / 63) * 65535)),
      );
    }
  });

  it('запись и чтение: узлы с точностью 16 бит, вне 0..1 — срез', () => {
    const random = seededRandom(4);
    const lut = createLut(16, () => [random() * 1.2 - 0.1, random(), random()]);
    const back = haldToLut(lutToHald(lut));
    expect(back.size).toBe(16);
    for (let i = 0; i < lut.data.length; i++) {
      const v = Math.min(1, Math.max(0, lut.data[i] as number));
      expect(Math.abs((back.data[i] as number) - v)).toBeLessThanOrEqual(0.5 / 65535 + 1e-12);
    }
  });

  it('читает и 8-битный Hald', () => {
    const image = lutToHald(identityLut(16));
    const data8 = Uint8Array.from(image.data, (v) => Math.round(v / 257));
    const lut = haldToLut({ width: image.width, height: image.height, data: data8 }, 255);
    const i = lutIndex(16, 15, 0, 5);
    expect(lut.data[i]).toBe(1);
    expect(lut.data[i + 2]).toBeCloseTo(5 / 15, 2);
  });

  it('размер решётки должен быть квадратом уровня, картинка — кубом', () => {
    expect(() => lutToHald(identityLut(33))).toThrow(/квадрат/);
    expect(() => haldToLut({ width: 500, height: 500, data: new Uint16Array(500 * 500 * 3) })).toThrow(/HaldCLUT/);
  });
});
