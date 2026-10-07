import { describe, expect, it } from 'vitest';
import { HSL_HUE_SHIFT, HUE_BAND_CENTERS } from '@core/color/hsl';
import { linearSrgbToOklab, oklabToOklch } from '@core/color/oklab';
import type { Rgb } from '@core/color/srgb';
import { hslTrack, wheelFromPoint, wheelImage, wheelToPoint } from '@core/color/swatches';
import { decodeSrgb } from '@core/color/transfer';
import { HUE_BANDS } from '@core/project/defaults';

const lch = (rgb: Rgb) => oklabToOklch(linearSrgbToOklab(decodeSrgb(rgb)));
const hueDistance = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('круг цветокоррекции', () => {
  it('точка ↔ тон и сила: тон против часовой от оси вправо, сила — расстояние от центра', () => {
    expect(wheelFromPoint(1, 0)).toEqual({ hue: 0, amount: 100 });
    expect(wheelFromPoint(0, -0.5)).toEqual({ hue: 90, amount: 50 });
    expect(wheelFromPoint(-0.25, 0)).toEqual({ hue: 180, amount: 25 });
    expect(wheelFromPoint(0, 1)).toEqual({ hue: 270, amount: 100 });
    // За краем сила не больше 100, в центре — 0.
    expect(wheelFromPoint(3, 0)).toEqual({ hue: 0, amount: 100 });
    expect(wheelFromPoint(0, 0)).toEqual({ hue: 0, amount: 0 });
    for (const [hue, amount] of [
      [0, 0],
      [37, 12],
      [264, 80],
      [359, 100],
    ] as const) {
      const [x, y] = wheelToPoint(hue, amount);
      expect(wheelFromPoint(x, y)).toEqual({ hue: amount === 0 ? 0 : hue, amount });
    }
  });

  it('тон всегда 0..359, сила 0..100, целые', () => {
    for (let i = 0; i < 500; i++) {
      const a = (i * 0.731) % (2 * Math.PI);
      const r = (i % 13) / 10;
      const { hue, amount } = wheelFromPoint(r * Math.cos(a), r * Math.sin(a));
      expect(Number.isInteger(hue) && hue >= 0 && hue < 360).toBe(true);
      expect(Number.isInteger(amount) && amount >= 0 && amount <= 100).toBe(true);
    }
  });

  it('картинка круга: прозрачно за краем, серый в центре, тон по углу', () => {
    const size = 64;
    const data = wheelImage(size);
    expect(data).toHaveLength(size * size * 4);
    const at = (x: number, y: number): [Rgb, number] => {
      const i = (y * size + x) * 4;
      return [[data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255], data[i + 3]!];
    };
    expect(at(0, 0)[1]).toBe(0);
    const [center, alpha] = at(32, 32);
    expect(alpha).toBe(255);
    expect(lch(center)[1]).toBeLessThan(0.01);
    // Справа от центра — тон около 0°, сверху — около 90°, снизу — около 270°.
    expect(hueDistance(lch(at(58, 32)[0])[2], 0)).toBeLessThan(8);
    expect(hueDistance(lch(at(32, 6)[0])[2], 90)).toBeLessThan(8);
    expect(hueDistance(lch(at(32, 58)[0])[2], 270)).toBeLessThan(8);
  });
});

describe('дорожки ползунков HSL', () => {
  it('насыщенность: от серого к насыщенному, тон диапазона', () => {
    for (const band of HUE_BANDS) {
      const track = hslTrack(band, 'sat');
      expect(lch(track[0]!)[1]).toBeLessThan(0.005);
      for (let i = 1; i < track.length; i++) expect(lch(track[i]!)[1]).toBeGreaterThan(lch(track[i - 1]!)[1] - 1e-6);
      expect(hueDistance(lch(track.at(-1)!)[2], HUE_BAND_CENTERS[band])).toBeLessThan(6);
    }
  });

  it('тон: от центра −30° до +30°', () => {
    for (const band of HUE_BANDS) {
      const track = hslTrack(band, 'hue');
      const center = HUE_BAND_CENTERS[band];
      expect(hueDistance(lch(track[0]!)[2], center - HSL_HUE_SHIFT)).toBeLessThan(6);
      expect(hueDistance(lch(track[Math.floor(track.length / 2)]!)[2], center)).toBeLessThan(6);
      expect(hueDistance(lch(track.at(-1)!)[2], center + HSL_HUE_SHIFT)).toBeLessThan(6);
    }
  });

  it('яркость: светлота растёт слева направо', () => {
    for (const band of HUE_BANDS) {
      const track = hslTrack(band, 'lum');
      for (let i = 1; i < track.length; i++) expect(lch(track[i]!)[0]).toBeGreaterThan(lch(track[i - 1]!)[0]);
    }
  });
});
