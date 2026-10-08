// Режим 7 «Отклонение»: насколько средние плитки далеки от цели позиции (docs/decisions/0012-view-modes.md)
// или, без цели, от ожидания сетки (harmony/outliers.ts, ADR 0020). Отклонение нормировано на допуск:
// 0 — ровно в ожидании, 1 — на краю допуска. Части отклонения — те же причины, что у выбросов.
import { hueDistance } from '../color/math';
import { oklabToLinearSrgb, oklchToOklab } from '../color/oklab';
import type { Lab, Rgb } from '../color/srgb';
import { encodeSrgbClamped } from '../color/transfer';
import type { SlotTarget } from '../project/types';
import type { LabStats } from './palette';

/** От этой хромы тон плитки весит полностью; у почти серой плитки тон — шум. */
export const DEVIATION_HUE_CHROMA = 0.05;

/** Величина, по которой плитка отклоняется: яркость, температура, хрома (насыщенность), тон. */
export type DeviationReason = 'L' | 'temperature' | 'chroma' | 'hue';

/** Одна часть отклонения: величина плитки, ожидание, допуск и отклонение в долях допуска. */
export interface DeviationPart {
  reason: DeviationReason;
  /** Значение плитки: L, температура, хрома или тон в градусах. */
  value: number;
  /** Ожидание: цель или ожидание сетки; у тона без цели — ближайший край сектора (внутри — сам тон). */
  expected: number;
  tolerance: number;
  /** Отклонение в долях допуска, у тона — с весом хромы: 0 — в ожидании, 1 — край допуска. */
  ratio: number;
}

/** Вес тона по хроме плитки: 0 у серой, 1 от DEVIATION_HUE_CHROMA. */
export function hueChromaWeight(chroma: number): number {
  return Math.min(1, Math.max(0, chroma / DEVIATION_HUE_CHROMA));
}

/** |delta| в долях допуска; нулевой допуск — 0 при точном попадании и ∞ иначе. */
export function toleranceRatio(delta: number, tolerance: number): number {
  const d = Math.abs(delta);
  if (tolerance > 0) return d / tolerance;
  return d === 0 ? 0 : Infinity;
}

/** Тон в долях допуска с весом хромы; у серой плитки — 0, даже при нулевом допуске. */
export function weightedHueRatio(distance: number, tolerance: number, chroma: number): number {
  const weight = hueChromaWeight(chroma);
  return weight === 0 ? 0 : weight * toleranceRatio(distance, tolerance);
}

/**
 * Части отклонения от цели: L всегда, хрома и тон — только если цель их задаёт. Тон — с весом по хроме
 * плитки. Палитра цели пока не учитывается: её сравнение — на этапе 5.
 */
export function targetParts(stats: Pick<LabStats, 'meanL' | 'meanC' | 'hue'>, target: SlotTarget): DeviationPart[] {
  const { tolerance } = target;
  const parts: DeviationPart[] = [
    { reason: 'L', value: stats.meanL, expected: target.L, tolerance: tolerance.L, ratio: toleranceRatio(stats.meanL - target.L, tolerance.L) },
  ];
  if (target.chroma !== undefined) {
    const ratio = toleranceRatio(stats.meanC - target.chroma, tolerance.chroma);
    parts.push({ reason: 'chroma', value: stats.meanC, expected: target.chroma, tolerance: tolerance.chroma, ratio });
  }
  if (target.hue !== undefined) {
    const ratio = weightedHueRatio(hueDistance(stats.hue, target.hue), tolerance.hue, stats.meanC);
    parts.push({ reason: 'hue', value: stats.hue, expected: target.hue, tolerance: tolerance.hue, ratio });
  }
  return parts;
}

/** Худшая из частей — значение режима 7; без частей — 0. */
export function worstRatio(parts: readonly DeviationPart[]): number {
  return parts.reduce((worst, part) => Math.max(worst, part.ratio), 0);
}

/** Отклонение от цели: худшая из частей `targetParts`. */
export function deviation(stats: Pick<LabStats, 'meanL' | 'meanC' | 'hue'>, target: SlotTarget): number {
  return worstRatio(targetParts(stats, target));
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
