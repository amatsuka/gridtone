// Режим 7 «Отклонение»: насколько средние плитки далеки от цели позиции (docs/decisions/0012-view-modes.md).
// Отклонение нормировано на допуск цели: 0 — ровно в цели, 1 — на краю допуска.
import { hueDistance } from '../color/math';
import { oklabToLinearSrgb, oklchToOklab } from '../color/oklab';
import type { Lab, Rgb } from '../color/srgb';
import { encodeSrgbClamped } from '../color/transfer';
import type { SlotTarget } from '../project/types';
import type { LabStats } from './palette';

/** От этой средней хромы тон плитки весит полностью; у почти серой плитки тон — шум. */
export const DEVIATION_HUE_CHROMA = 0.05;

/**
 * Худшая из частей: |ΔL| / τL, а если цель задаёт тон и хрому — Δтона / τтона (с весом по хроме
 * плитки) и |ΔC| / τC. Палитра цели пока не учитывается: её сравнение — на этапе 5.
 */
export function deviation(stats: Pick<LabStats, 'meanL' | 'meanC' | 'hue'>, target: SlotTarget): number {
  const { tolerance } = target;
  let worst = ratio(Math.abs(stats.meanL - target.L), tolerance.L);
  if (target.hue !== undefined) {
    const weight = Math.min(1, stats.meanC / DEVIATION_HUE_CHROMA);
    worst = Math.max(worst, weight * ratio(hueDistance(stats.hue, target.hue), tolerance.hue));
  }
  if (target.chroma !== undefined) worst = Math.max(worst, ratio(Math.abs(stats.meanC - target.chroma), tolerance.chroma));
  return worst;
}

function ratio(delta: number, tolerance: number): number {
  if (tolerance > 0) return delta / tolerance;
  return delta === 0 ? 0 : Infinity;
}

// Опорные цвета шкалы в OKLCH: одной светлоты и хромы, чтобы шкала не скакала по яркости.
const SCALE: readonly Lab[] = [
  oklchToOklab([0.72, 0.17, 145]), // 0 — в цели
  oklchToOklab([0.84, 0.16, 95]), // 1 — край допуска
  oklchToOklab([0.63, 0.2, 29]), // 2 и дальше
];

/** Цвет тепловой карты: зелёный → жёлтый → красный, интерполяция в OKLab. sRGB 0..1. */
export function deviationColor(d: number): Rgb {
  const t = Math.min(2, Math.max(0, Number.isNaN(d) ? 2 : d));
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const from = SCALE[i] as Lab;
  const to = SCALE[i + 1] as Lab;
  const lab: Lab = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
  return encodeSrgbClamped(oklabToLinearSrgb(lab));
}
