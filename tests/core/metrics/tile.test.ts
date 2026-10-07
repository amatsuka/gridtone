import { describe, expect, it } from 'vitest';
import { linearSrgbToOklab } from '@core/color/oklab';
import { applyPipeline } from '@core/color/pipeline';
import type { Rgb } from '@core/color/srgb';
import { decodeSrgb } from '@core/color/transfer';
import type { RgbaImage } from '@core/image/sample';
import { labToSrgb8, metricsWindowSize, tileLab, tileMetrics } from '@core/metrics/tile';
import { createAdjust, createCrop } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';

function image(width: number, height: number, color: (x: number, y: number) => Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      color(x, y).forEach((v, c) => (data[i + c] = Math.round(v * 255)));
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const lab = (rgb: Rgb) => linearSrgbToOklab(decodeSrgb(rgb));
const ORANGE: Rgb = [200 / 255, 120 / 255, 40 / 255];
const TEAL: Rgb = [30 / 255, 140 / 255, 150 / 255];

function adjust(patch: Partial<Adjust>): Adjust {
  return { ...createAdjust(), ...patch };
}

describe('метрики плитки по окну сетки', () => {
  it('окно 192 × 256 для 3:4 и 192 × 192 для 1:1', () => {
    expect(metricsWindowSize('3:4')).toEqual([192, 256]);
    expect(metricsWindowSize('1:1')).toEqual([192, 192]);
  });

  it('однотонное фото без правок: доминанта и среднее — его цвет', () => {
    const m = tileMetrics(image(120, 160, () => ORANGE), createCrop(), '3:4', { photo: createAdjust() });
    const expected = lab(ORANGE);
    expect(m.palette).toHaveLength(1);
    m.dominant.forEach((v, i) => expect(v).toBeCloseTo(expected[i] as number, 5));
    expect(m.meanL).toBeCloseTo(expected[0], 5);
    expect(labToSrgb8(m.dominant)).toEqual([200, 120, 40]);
  });

  it('правки поправки фото и образа входят в метрики, как в конвейере', () => {
    const params = { photo: adjust({ exposure: 0.5, temp: 20 }), look: adjust({ saturation: -40 }) };
    const m = tileMetrics(image(60, 80, () => TEAL), createCrop(), '3:4', params);
    const expected = lab(applyPipeline(TEAL, params));
    m.dominant.forEach((v, i) => expect(v).toBeCloseTo(expected[i] as number, 5));
  });

  it('считается только окно сетки: широкие поля альбомного фото не попадают', () => {
    // Фото 4:3, по краям поля другого цвета; окно 3:4 по центру их не видит.
    const m = tileMetrics(
      image(200, 150, (x) => (x < 30 || x >= 170 ? TEAL : ORANGE)),
      createCrop(),
      '3:4',
      { photo: createAdjust() },
    );
    expect(m.palette).toHaveLength(1);
    expect(labToSrgb8(m.dominant)).toEqual([200, 120, 40]);
  });

  it('главный цвет — с наибольшей долей', () => {
    // Верхние 70% — оранжевые, нижние 30% — бирюзовые.
    const m = tileMetrics(image(90, 120, (_, y) => (y < 84 ? ORANGE : TEAL)), createCrop(), '3:4', { photo: createAdjust() });
    expect(labToSrgb8(m.dominant)).toEqual([200, 120, 40]);
    expect(m.palette.length).toBeGreaterThanOrEqual(2);
  });

  it('tileLab — пиксели окна в OKLab', () => {
    const labs = tileLab(image(30, 40, () => ORANGE), createCrop(), '3:4', { photo: createAdjust() });
    expect(labs).toHaveLength(192 * 256 * 3);
    const expected = lab(ORANGE);
    for (let c = 0; c < 3; c++) expect(labs[c]).toBeCloseTo(expected[c] as number, 5);
  });
});
