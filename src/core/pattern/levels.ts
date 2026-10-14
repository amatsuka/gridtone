// Уровни яркости паттерна и допуски целей (docs/spec.md, «Модуль 4. Паттерны»; docs/decisions/0023-patterns.md).
// L, M, D — светлый, средний и тёмный: середина ± половина контраста. Жёсткая цель — плоская заливка шаблона
// (генератор, строка, однотонная ячейка картинки), мягкая — снята с фото в ячейке картинки (5в).
// Числа стартовые, их калибрует ручной чек-лист этапа 5.
import { NEUTRAL_CHROMA } from '../metrics/features';
import type { SlotTarget } from '../project/types';

export type Level = 'L' | 'M' | 'D';

export const LEVELS: readonly Level[] = ['L', 'M', 'D'];

export const LEVEL_LABELS: Record<Level, string> = { L: 'светлый', M: 'средний', D: 'тёмный' };

/** Параметры уровней: середина — L уровня M, контраст — разница L между L и D. */
export interface LevelParams {
  center: number;
  contrast: number;
}

/** L 0.80, M 0.62, D 0.44. */
export const DEFAULT_LEVELS: LevelParams = { center: 0.62, contrast: 0.36 };
/** Пределы ползунков «Середина» и «Контраст». */
export const LEVEL_CENTER_RANGE: readonly [number, number] = [0.2, 0.9];
export const LEVEL_CONTRAST_RANGE: readonly [number, number] = [0, 0.6];

export type Tolerance = SlotTarget['tolerance'];

/** Жёсткая цель: L — как допуск ожидания сетки (ADR 0020); тон и хрома — для плоской заливки. */
export const HARD_TOLERANCE: Readonly<Tolerance> = { L: 0.06, hue: 15, chroma: 0.02 };
/** Мягкая цель — снята с фото: шире по всем величинам. */
export const SOFT_TOLERANCE: Readonly<Tolerance> = { L: 0.1, hue: 25, chroma: 0.03 };

/** Цвет цели: тон в градусах и хрома OKLCH. Без тона — важна только насыщенность. */
export interface TargetColor {
  hue?: number;
  chroma: number;
}

/** Знаков после запятой у чисел цели: project.json остаётся читаемым, сравнение — точным. */
const DIGITS = 1e4;

export function roundTarget(value: number): number {
  return Math.round(value * DIGITS) / DIGITS;
}

/** L уровня: середина ± половина контраста, в пределах 0..1. */
export function levelL(level: Level, { center, contrast }: LevelParams): number {
  const offset = level === 'L' ? contrast / 2 : level === 'D' ? -contrast / 2 : 0;
  return roundTarget(Math.min(1, Math.max(0, center + offset)));
}

/**
 * Цвет точки (a, b): тон — только если хрома не меньше minChroma. По умолчанию это NEUTRAL_CHROMA: у почти серой
 * ячейки картинки тон — шум (5в). Генератор задаёт направление сам и берёт порог около нуля.
 */
export function targetColorFromAb(a: number, b: number, minChroma = NEUTRAL_CHROMA): TargetColor {
  const chroma = Math.hypot(a, b);
  if (chroma < minChroma) return { chroma };
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return { hue: hue < 0 ? hue + 360 : hue, chroma };
}

/** Жёсткая цель: плоская заливка шаблона. */
export function hardTarget(L: number, color?: TargetColor): SlotTarget {
  return makeTarget(L, color, HARD_TOLERANCE, true);
}

/** Мягкая цель: снята с фото. */
export function softTarget(L: number, color?: TargetColor): SlotTarget {
  return makeTarget(L, color, SOFT_TOLERANCE, false);
}

function makeTarget(L: number, color: TargetColor | undefined, tolerance: Readonly<Tolerance>, hard: boolean): SlotTarget {
  const target: SlotTarget = { L: roundTarget(L), tolerance: { ...tolerance }, hard };
  if (color?.hue !== undefined) target.hue = roundTarget(((color.hue % 360) + 360) % 360);
  if (color) target.chroma = roundTarget(Math.max(0, color.chroma));
  // 359.99996 после округления — 360: тон в 0..360.
  if (target.hue === 360) target.hue = 0;
  return target;
}
