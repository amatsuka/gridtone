import { describe, expect, it } from 'vitest';
import type { Rgb } from '@core/color/srgb';
import type { RgbaImage } from '@core/image/sample';
import {
  HUE_HIST_BINS,
  L_HIST_BINS,
  NEUTRAL_CHROMA,
  percentile,
  TEMPERATURE_AXIS,
  temperature,
  tileFeatures,
  TINT_AXIS,
} from '@core/metrics/features';
import { labStats, palette } from '@core/metrics/palette';
import { tileMetrics } from '@core/metrics/tile';
import { createAdjust, createCrop } from '@core/project/defaults';
import type { Adjust, Vec3 } from '@core/project/types';
import { seededRandom } from '../color/helpers';

/** Окно OKLab width × height по функции цвета точки. */
function window(width: number, height: number, color: (x: number, y: number) => Vec3): Float64Array {
  const labs = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) labs.set(color(x, y), (y * width + x) * 3);
  return labs;
}

const gray = (L: number): Vec3 => [L, 0, 0];
/** OKLCH → OKLab. */
const lch = (L: number, C: number, h: number): Vec3 => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);

describe('признаки плитки', () => {
  it('рампа L: перцентили, гистограмма из 8 равных корзин, среднее', () => {
    // 200 столбцов от 0.0025 до 0.9975: по 25 в каждой корзине.
    const f = tileFeatures(window(200, 4, (x) => gray((x + 0.5) / 200)), 200, 4);
    expect(f.meanL).toBeCloseTo(0.5, 12);
    expect(f.p50L).toBeCloseTo(0.5, 12);
    expect(f.p05L).toBeCloseTo(0.05, 2);
    expect(f.p95L).toBeCloseTo(0.95, 2);
    expect(f.lHist).toHaveLength(L_HIST_BINS);
    for (const share of f.lHist) expect(share).toBeCloseTo(1 / 8, 12);
  });

  it('перцентиль — линейная интерполяция между порядковыми статистиками', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('гистограмма L: светлее 1 — в последней корзине, доли в сумме 1', () => {
    const f = tileFeatures(window(10, 10, (x) => gray(x < 5 ? 1.0000001 : 0.1)), 10, 10);
    expect(f.lHist[7]).toBeCloseTo(0.5, 12);
    expect(f.lHist[0]).toBeCloseTo(0.5, 12);
    expect(sum(f.lHist)).toBeCloseTo(1, 12);
  });

  it('ключ: доли L > 0.8 и L < 0.3, границы не входят', () => {
    // 100 столбцов: 30 светлых, 20 тёмных, 10 ровно на границах, остальные средние.
    const f = tileFeatures(
      window(100, 3, (x) => gray(x < 30 ? 0.9 : x < 50 ? 0.2 : x < 55 ? 0.8 : x < 60 ? 0.3 : 0.5)),
      100,
      3,
    );
    expect(f.highKeyShare).toBeCloseTo(0.3, 12);
    expect(f.lowKeyShare).toBeCloseTo(0.2, 12);
  });

  it('доля нейтральных: серое с цветным пятном в четверть кадра', () => {
    const f = tileFeatures(window(40, 40, (x, y) => (x < 20 && y < 20 ? lch(0.6, 0.1, 140) : gray(0.6))), 40, 40);
    expect(f.neutralShare).toBeCloseTo(0.75, 12);
    // Порог хромы: чуть ниже — нейтральный, чуть выше — нет.
    const edge = tileFeatures(window(2, 1, (x) => lch(0.5, x === 0 ? NEUTRAL_CHROMA * 0.99 : NEUTRAL_CHROMA * 1.01, 30)), 2, 1);
    expect(edge.neutralShare).toBe(0.5);
  });

  it('гистограмма тонов по 30° с весом хромы: в сумме средняя хрома', () => {
    // Половина — тон 45°, хрома 0.1; четверть — тон 200°, хрома 0.04; четверть серого.
    const f = tileFeatures(
      window(4, 10, (x) => (x < 2 ? lch(0.6, 0.1, 45) : x < 3 ? lch(0.5, 0.04, 200) : gray(0.5))),
      4,
      10,
    );
    expect(f.hueHist).toHaveLength(HUE_HIST_BINS);
    expect(f.hueHist[1]).toBeCloseTo(0.05, 12);
    expect(f.hueHist[6]).toBeCloseTo(0.01, 12);
    expect(f.hueHist.filter((_, i) => i !== 1 && i !== 6).every((v) => v === 0)).toBe(true);
    expect(sum(f.hueHist)).toBeCloseTo(f.meanC, 12);
    expect(f.meanC).toBeCloseTo(0.06, 12);
  });

  it('гистограмма тонов: 359° — в последней корзине, 0° и 29.9° — в первой, 30.1° — во второй', () => {
    const f = tileFeatures(window(4, 1, (x) => lch(0.6, 0.1, [359, 0, 29.9, 30.1][x] as number)), 4, 1);
    expect(f.hueHist[11]).toBeCloseTo(0.025, 12);
    expect(f.hueHist[0]).toBeCloseTo(0.05, 12);
    expect(f.hueHist[1]).toBeCloseTo(0.025, 12);
  });

  it('средние и палитра — те же, что у палитры плитки', () => {
    const random = seededRandom(5);
    const labs = window(30, 40, () => lch(0.3 + random() * 0.5, random() * 0.15, random() * 360));
    const f = tileFeatures(labs, 30, 40);
    const stats = labStats(labs);
    expect([f.meanL, f.meanA, f.meanB, f.meanC]).toEqual([stats.meanL, stats.meanA, stats.meanB, stats.meanC]);
    expect(f.palette).toEqual(palette(labs));
  });

  describe('плотность — энергия краёв по Собелю', () => {
    // Ширина как у окна метрик.
    const W = 192;
    const H = 32;
    const busyness = (color: (x: number, y: number) => Vec3) => tileFeatures(window(W, H, color), W, H).busyness;

    it('у однотонного 0', () => {
      expect(busyness(() => lch(0.6, 0.1, 30))).toBe(0);
    });

    it('плавная рампа — перепад L на точку', () => {
      expect(busyness((x) => gray(0.2 + (0.6 * x) / (W - 1)))).toBeCloseTo(0.6 / (W - 1), 12);
    });

    it('одна граница 0.3 | 0.7 — её перепад на ширину внутренней части', () => {
      expect(busyness((x) => gray(x < W / 2 ? 0.3 : 0.7))).toBeCloseTo(0.4 / (W - 2), 12);
    });

    it('у шума и полос выше, чем у гладкого', () => {
      const smooth = busyness((x) => gray(0.2 + (0.6 * x) / (W - 1)));
      const random = seededRandom(9);
      const noise = busyness(() => gray(0.4 + random() * 0.2));
      const stripes = busyness((x) => gray(Math.floor(x / 4) % 2 ? 0.3 : 0.7));
      expect(noise).toBeGreaterThan(smooth * 5);
      expect(stripes).toBeGreaterThan(smooth * 5);
      // Чем чаще полосы, тем «шумнее» кадр.
      expect(stripes).toBeGreaterThan(busyness((x) => gray(Math.floor(x / 16) % 2 ? 0.3 : 0.7)));
    });
  });

  it('окно не совпадает с числом точек — ошибка', () => {
    expect(() => tileFeatures(new Float64Array(30), 4, 3)).toThrow();
  });
});

describe('температура', () => {
  function image(color: Rgb): RgbaImage {
    const data = new Uint8ClampedArray(30 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data.set(color.map((v) => Math.round(v * 255)), i);
      data[i + 3] = 255;
    }
    return { width: 30, height: 40, data };
  }
  const adjust = (patch: Partial<Adjust>): Adjust => ({ ...createAdjust(), ...patch });
  const temperatureOf = (color: Rgb, patch: Partial<Adjust>) => {
    const m = tileMetrics(image(color), createCrop(), '3:4', { photo: adjust(patch) });
    return temperature(m.meanA, m.meanB);
  };

  it('оси единичные; ось температуры — почти b, к жёлтому', () => {
    expect(Math.hypot(...TEMPERATURE_AXIS)).toBeCloseTo(1, 12);
    expect(Math.hypot(...TINT_AXIS)).toBeCloseTo(1, 12);
    expect(TEMPERATURE_AXIS[1]).toBeGreaterThan(0.95);
    expect(temperature(...TEMPERATURE_AXIS)).toBeCloseTo(1, 12);
    expect(temperature(...TINT_AXIS)).toBeCloseTo(0, 12);
    // Серый — ни тёплый, ни холодный.
    expect(temperature(0, 0)).toBe(0);
  });

  it('растёт с ползунком температуры', () => {
    const gray: Rgb = [0.5, 0.5, 0.5];
    const values = [-60, -30, -10, 0, 10, 30, 60].map((temp) => temperatureOf(gray, { temp }));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    expect(values[3]).toBeCloseTo(0, 3);
    expect(values[6]).toBeGreaterThan(0.02);
  });

  it('почти не меняется от оттенка: у серого — меньше 1% сдвига температурой, у цветного кадра — меньше трети', () => {
    // Ось оттенка у серого — ровно та, вдоль которой меряем. У цветного кадра баланс белого сдвигает (a, b)
    // чуть иначе, чем у серого (кубический корень OKLab), и часть сдвига оттенком попадает в температуру.
    const cases: [Rgb, number][] = [
      [[0.5, 0.5, 0.5], 0.01],
      [[0.85, 0.7, 0.55], 1 / 3],
      [[0.3, 0.45, 0.6], 1 / 3],
    ];
    for (const [color, limit] of cases) {
      const byTemp = Math.abs(temperatureOf(color, { temp: 40 }) - temperatureOf(color, { temp: -40 }));
      const byTint = Math.abs(temperatureOf(color, { tint: 40 }) - temperatureOf(color, { tint: -40 }));
      expect(byTemp).toBeGreaterThan(0.02);
      expect(byTint, `цвет ${color.join(', ')}`).toBeLessThan(byTemp * limit);
    }
  });

  it('тёплый кадр теплее холодного', () => {
    expect(temperatureOf([0.85, 0.65, 0.45], {})).toBeGreaterThan(0.03);
    expect(temperatureOf([0.45, 0.6, 0.85], {})).toBeLessThan(-0.03);
  });
});
