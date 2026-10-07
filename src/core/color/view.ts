// Режимы просмотра 3 и 4 — пост-обработка после проходов конвейера (docs/decisions/0012-view-modes.md).
// Шейдер повторяет её в applyView; коды режимов и число уровней program.ts подставляет из этого файла.
import { linearSrgbToOklab } from './oklab';
import type { Rgb } from './srgb';
import { decodeSrgb, linearToSrgb } from './transfer';

/** Что шейдер делает после проходов: ничего, серый той же светлоты или постеризация. */
export type ViewOutput = 'color' | 'luminance' | 'posterize';

/** Коды для шейдера: program.ts подставляет их как #define. */
export const VIEW_OUTPUT_CODES: Readonly<Record<ViewOutput, number>> = { color: 0, luminance: 1, posterize: 2 };

/** Уровней яркости в постеризации. Их же возьмут паттерны L/M/D на этапе 4. */
export const POSTERIZE_LEVELS = 5;

/** Границы уровней по OKLab L: равные шаги от 0 до 1. */
export const POSTERIZE_BOUNDARIES: readonly number[] = Array.from({ length: POSTERIZE_LEVELS - 1 }, (_, k) => (k + 1) / POSTERIZE_LEVELS);

/** OKLab L гамма-кодированного цвета sRGB. */
export function oklabL(rgb: Rgb): number {
  return linearSrgbToOklab(decodeSrgb(rgb))[0];
}

/** Номер уровня 0..POSTERIZE_LEVELS − 1. */
export function posterizeLevel(L: number): number {
  const t = Math.min(1, Math.max(0, L));
  return Math.min(Math.floor(t * POSTERIZE_LEVELS), POSTERIZE_LEVELS - 1);
}

/** Светлота уровня — середина его отрезка. */
export function levelL(level: number): number {
  return (level + 0.5) / POSTERIZE_LEVELS;
}

/**
 * Серый с данным OKLab L. При a = b = 0 все три значения LMS равны L, а строки обратной матрицы
 * в сумме дают 1, поэтому линейный серый — ровно L³.
 */
export function grayOfL(L: number): Rgb {
  const lin = L * L * L;
  const v = lin >= 1 ? 1 : lin <= 0 ? 0 : linearToSrgb(lin);
  return [v, v, v];
}

/** Вход и выход — sRGB 0..1 после конвейера. */
export function applyView(rgb: Rgb, view: ViewOutput): Rgb {
  if (view === 'color') return rgb;
  const L = oklabL(rgb);
  return grayOfL(view === 'posterize' ? levelL(posterizeLevel(L)) : L);
}
