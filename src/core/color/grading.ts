// Цветокоррекция по трём кругам в OKLab, шаг 7 конвейера (после HSL).
// Каждый круг сдвигает a и b в сторону своего тона; маски теней, средних и светов — по L.
import type { Adjust } from '../project/types';
import type { Lab } from './srgb';

/** Сила 100 сдвигает цвет на 0.08 по хроме OKLab. */
export const GRADING_MAX_CHROMA = 0.08;

export interface BakedGrading {
  /** Сдвиги (a, b) при полном весе маски. */
  shadows: [number, number];
  midtones: [number, number];
  highlights: [number, number];
  /** Показатель степени для L перед масками: баланс в плюс отдаёт больше тонов светам. */
  exponent: number;
}

/** null — все три круга с нулевой силой. */
export function bakeGrading(grading: Adjust['grading']): BakedGrading | null {
  const { shadows, midtones, highlights, balance } = grading;
  if (shadows.amount === 0 && midtones.amount === 0 && highlights.amount === 0) return null;
  const offset = ({ hue, amount }: { hue: number; amount: number }): [number, number] => {
    const rad = (hue * Math.PI) / 180;
    const chroma = (amount / 100) * GRADING_MAX_CHROMA;
    return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
  };
  return {
    shadows: offset(shadows),
    midtones: offset(midtones),
    highlights: offset(highlights),
    exponent: Math.pow(2, -balance / 100),
  };
}

/** Веса теней, средних и светов: квадратичный базис Бернштейна по L^exponent, в сумме 1. */
export function gradingWeights(L: number, exponent: number): [number, number, number] {
  const t = Math.pow(Math.min(1, Math.max(0, L)), exponent);
  const u = 1 - t;
  return [u * u, 2 * t * u, t * t];
}

export function applyGrading(lab: Lab, baked: BakedGrading): Lab {
  const [L, a, b] = lab;
  const [ws, wm, wh] = gradingWeights(L, baked.exponent);
  return [
    L,
    a + ws * baked.shadows[0] + wm * baked.midtones[0] + wh * baked.highlights[0],
    b + ws * baked.shadows[1] + wm * baked.midtones[1] + wh * baked.highlights[1],
  ];
}
