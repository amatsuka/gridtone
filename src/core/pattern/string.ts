// Строка-шаблон (docs/spec.md, «Откуда берётся паттерн»; docs/decisions/0023-patterns.md): ряды по три символа
// L, M, D — светлый, средний, тёмный; ряды разделяются `/` или переводом строки, регистр не важен, пробелы
// и пустые ряды пропускаются. Период — число рядов. Ошибка называет ряд и символ, проект не меняется.
import type { Pattern } from '../project/types';
import { hardTarget, levelL, LEVELS, type Level, type LevelParams } from './levels';
import { makePattern, PATTERN_COLUMNS, PATTERN_MAX_ROWS } from './pattern';

export type PatternStringParse =
  | { ok: true; rows: Level[][] }
  | {
      ok: false;
      error: string;
      /** Ряд с ошибкой, с 1 (среди непустых); null — ошибка всей строки. */
      row: number | null;
      /** Символ с ошибкой в ряду, с 1; null — ошибка длины ряда. */
      column: number | null;
    };

export function parsePatternString(text: string): PatternStringParse {
  const rows = text
    .split(/\/|\r?\n/)
    .map((row) => row.replace(/\s+/g, ''))
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return { ok: false, row: null, column: null, error: 'Пустая строка: нужен хотя бы один ряд из трёх символов L, M или D.' };
  }
  const parsed: Level[][] = [];
  for (const [r, row] of rows.entries()) {
    const n = r + 1;
    if (n > PATTERN_MAX_ROWS) {
      return { ok: false, row: n, column: null, error: `Ряд ${n}: в периоде не больше ${PATTERN_MAX_ROWS} рядов.` };
    }
    const chars = [...row.toUpperCase()];
    const bad = chars.findIndex((c) => !LEVELS.includes(c as Level));
    if (bad >= 0) {
      // Символ — как его ввели, а не в верхнем регистре.
      return { ok: false, row: n, column: bad + 1, error: `Ряд ${n}, символ ${bad + 1}: «${[...row][bad]}» — нужен L, M или D.` };
    }
    if (chars.length !== PATTERN_COLUMNS) {
      return { ok: false, row: n, column: null, error: `Ряд ${n}: «${row}» — нужно ровно ${PATTERN_COLUMNS} символа L, M или D.` };
    }
    parsed.push(chars as Level[]);
  }
  return { ok: true, rows: parsed };
}

/** Ряды → «LDL/DLD». */
export function formatPatternString(rows: readonly (readonly Level[])[]): string {
  return rows.map((row) => row.join('')).join('/');
}

/** Паттерн из строки: жёсткие цели уровней без цвета. */
export function stringPattern(text: string, levels: LevelParams): { ok: true; pattern: Pattern } | { ok: false; error: string } {
  const parsed = parsePatternString(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const cells = parsed.rows.flat().map((level) => hardTarget(levelL(level, levels)));
  return { ok: true, pattern: makePattern('string', cells) };
}
