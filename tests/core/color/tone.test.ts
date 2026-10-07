// Модель — docs/decisions/0006-tone-curve.md.
import { describe, expect, it } from 'vitest';
import { LUMINANCE, type Rgb } from '@core/color/srgb';
import { applyTone, toneCoefficients, toneCurve, type ToneSliders } from '@core/color/tone';

const NEUTRAL: ToneSliders = { contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
const SLIDERS = Object.keys(NEUTRAL) as (keyof ToneSliders)[];

function curve(sliders: Partial<ToneSliders>): (x: number) => number {
  const k = toneCoefficients({ ...NEUTRAL, ...sliders });
  if (!k) throw new Error('ожидалась ненейтральная кривая');
  return (x) => toneCurve(x, k);
}

const lum = (c: Rgb) => LUMINANCE[0] * c[0] + LUMINANCE[1] * c[1] + LUMINANCE[2] * c[2];

describe('тональная кривая', () => {
  it('нулевые ползунки — шаг нейтрален', () => {
    expect(toneCoefficients(NEUTRAL)).toBeNull();
  });

  it('при любом сочетании крайних значений: концы на месте, кривая строго растёт', () => {
    for (let m = 0; m < 3 ** 5; m++) {
      const sliders = { ...NEUTRAL };
      let rest = m;
      for (const name of SLIDERS) {
        sliders[name] = [-100, 0, 100][rest % 3] ?? 0;
        rest = Math.floor(rest / 3);
      }
      const k = toneCoefficients(sliders);
      if (!k) continue;
      expect(toneCurve(0, k)).toBe(0);
      expect(toneCurve(1, k)).toBe(1);
      let prev = 0;
      for (let i = 1; i <= 4096; i++) {
        const y = toneCurve(i / 4096, k);
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
    }
  });

  it('контраст: S-кривая вокруг 0.5', () => {
    const up = curve({ contrast: 100 });
    expect(up(0.5)).toBeCloseTo(0.5, 12);
    expect(up(0.25)).toBeLessThan(0.2);
    expect(up(0.75)).toBeGreaterThan(0.8);
    const down = curve({ contrast: -100 });
    expect(down(0.25)).toBeGreaterThan(0.3);
    expect(down(0.75)).toBeLessThan(0.7);
  });

  it('тени двигают нижнюю половину и почти не трогают света', () => {
    const up = curve({ shadows: 100 });
    expect(up(0.25)).toBeGreaterThan(0.35);
    expect(Math.abs(up(0.75) - 0.75)).toBeLessThan(0.01);
    expect(curve({ shadows: -100 })(0.25)).toBeLessThan(0.15);
  });

  it('света двигают верхнюю половину и почти не трогают тени', () => {
    const down = curve({ highlights: -100 });
    expect(down(0.75)).toBeLessThan(0.65);
    expect(Math.abs(down(0.25) - 0.25)).toBeLessThan(0.01);
    expect(curve({ highlights: 100 })(0.75)).toBeGreaterThan(0.85);
  });

  it('белые работают у белой точки: наклон в 1 и верхние четверть тонов', () => {
    const up = curve({ whites: 100 });
    expect(up(0.9)).toBeGreaterThan(0.93);
    expect((1 - up(1 - 1e-6)) / 1e-6).toBeLessThan(0.2);
    expect(Math.abs(up(0.5) - 0.5)).toBeLessThan(0.01);
    expect(curve({ whites: -100 })(0.9)).toBeLessThan(0.86);
  });

  it('чёрные работают у чёрной точки: наклон в 0 и нижняя четверть тонов', () => {
    const down = curve({ blacks: -100 });
    expect(down(0.1)).toBeLessThan(0.07);
    expect(down(1e-6) / 1e-6).toBeLessThan(0.2);
    expect(Math.abs(down(0.5) - 0.5)).toBeLessThan(0.01);
    expect(curve({ blacks: 100 })(0.1)).toBeGreaterThan(0.13);
  });

  describe('применение к пикселю', () => {
    const k = toneCoefficients({ ...NEUTRAL, shadows: 60, highlights: -40, contrast: 20 });
    if (!k) throw new Error('ожидалась ненейтральная кривая');

    it('сохраняет соотношение каналов', () => {
      for (const rgb of [
        [0.3, 0.1, 0.05],
        [0.02, 0.08, 0.35],
        [0.6, 0.5, 0.45],
      ] as Rgb[]) {
        const out = applyTone(rgb, k);
        expect(out[0] / out[1]).toBeCloseTo(rgb[0] / rgb[1], 12);
        expect(out[2] / out[1]).toBeCloseTo(rgb[2] / rgb[1], 12);
      }
    });

    it('меняет яркость по кривой', () => {
      const rgb: Rgb = [0.05, 0.04, 0.03];
      const strong = toneCoefficients({ ...NEUTRAL, shadows: 100 });
      if (!strong) throw new Error('ожидалась ненейтральная кривая');
      expect(lum(applyTone(rgb, strong))).toBeGreaterThan(lum(rgb) * 1.3);
    });

    it('осветление не выводит каналы за 1 и не меняет соотношение', () => {
      const bright = toneCoefficients({ ...NEUTRAL, shadows: 100, whites: 100, highlights: 100, contrast: -100 });
      if (!bright) throw new Error('ожидалась ненейтральная кривая');
      for (const rgb of [
        [0.9, 0.05, 0.02],
        [0.05, 0.05, 0.95],
        [0.99, 0.98, 0.2],
      ] as Rgb[]) {
        const out = applyTone(rgb, bright);
        expect(Math.max(...out)).toBeLessThanOrEqual(1 + 1e-12);
        expect(Math.max(...out)).toBeGreaterThanOrEqual(Math.max(...rgb));
        expect(out[2] / out[0]).toBeCloseTo(rgb[2] / rgb[0], 12);
      }
    });

    it('пиксель с Y ≥ 1 проходит без изменений', () => {
      const rgb: Rgb = [1.3, 0.97, 0.6];
      expect(lum(rgb)).toBeGreaterThanOrEqual(1);
      expect(applyTone(rgb, k)).toEqual(rgb);
    });

    it('чёрный остаётся чёрным, без NaN', () => {
      const lift = toneCoefficients({ ...NEUTRAL, blacks: 100, shadows: 100 });
      if (!lift) throw new Error('ожидалась ненейтральная кривая');
      expect(applyTone([0, 0, 0], lift)).toEqual([0, 0, 0]);
      const out = applyTone([1e-9, 0, 0], lift);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    });

    it('затемнение возвращает в охват то, что ярче белого лишь по одному каналу', () => {
      const darken = toneCoefficients({ ...NEUTRAL, highlights: -100 });
      if (!darken) throw new Error('ожидалась ненейтральная кривая');
      const rgb: Rgb = [1.2, 0.6, 0.2]; // Y ≈ 0.7
      const out = applyTone(rgb, darken);
      expect(Math.max(...out)).toBeLessThan(1);
      expect(out[1] / out[0]).toBeCloseTo(0.5, 12);
    });
  });
});
