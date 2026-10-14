import { describe, expect, test } from 'vitest';
import { DEFAULT_LEVELS, HARD_TOLERANCE } from '@core/pattern/levels';
import { PATTERN_MAX_ROWS } from '@core/pattern/pattern';
import { formatPatternString, parsePatternString, stringPattern } from '@core/pattern/string';

const rowsOf = (text: string) => {
  const result = parsePatternString(text);
  if (!result.ok) throw new Error(result.error);
  return result.rows.map((row) => row.join(''));
};

describe('строка-шаблон: разбор', () => {
  test('ряды по три символа через / или перевод строки; регистр не важен', () => {
    expect(rowsOf('LDL/DLD')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('ldl/dLd')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('LDL\nDLD')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('LDL\r\nDLD\r\n')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('MMM')).toEqual(['MMM']);
  });

  test('пробелы и пустые ряды не мешают', () => {
    expect(rowsOf(' L D L / D L D ')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('LDL/')).toEqual(['LDL']);
    expect(rowsOf('/LDL//DLD/')).toEqual(['LDL', 'DLD']);
    expect(rowsOf('\tLMD\n\nDML\n')).toEqual(['LMD', 'DML']);
  });

  test('ошибка называет ряд и символ', () => {
    expect(parsePatternString('LXL/DL')).toEqual({
      ok: false,
      row: 1,
      column: 2,
      error: 'Ряд 1, символ 2: «X» — нужен L, M или D.',
    });
    expect(parsePatternString('LDL/DL')).toEqual({
      ok: false,
      row: 2,
      column: null,
      error: 'Ряд 2: «DL» — нужно ровно 3 символа L, M или D.',
    });
    expect(parsePatternString('LDLD')).toMatchObject({ ok: false, row: 1, column: null });
    // Сначала — чужой символ, даже если ряд ещё и короткий.
    expect(parsePatternString('LDL/Q')).toMatchObject({ ok: false, row: 2, column: 1 });
    expect(parsePatternString('LDL/ЛДЛ')).toMatchObject({ ok: false, row: 2, column: 1, error: expect.stringContaining('«Л»') });
  });

  test('пустая строка и слишком длинный период — ошибки', () => {
    expect(parsePatternString('')).toMatchObject({ ok: false, row: null, column: null });
    expect(parsePatternString(' / \n')).toMatchObject({ ok: false, row: null });
    const long = Array(PATTERN_MAX_ROWS + 1).fill('LDL').join('/');
    expect(parsePatternString(long)).toMatchObject({ ok: false, row: PATTERN_MAX_ROWS + 1 });
    expect(rowsOf(Array(PATTERN_MAX_ROWS).fill('LDL').join('/'))).toHaveLength(PATTERN_MAX_ROWS);
  });

  test('formatPatternString — обратно в строку', () => {
    const parsed = parsePatternString('ldl/dld');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(formatPatternString(parsed.rows)).toBe('LDL/DLD');
  });
});

describe('строка-шаблон → паттерн', () => {
  test('LDL/DLD: период 2 ряда, жёсткие цели уровней, переживает одиночные посты', () => {
    const result = stringPattern('LDL/DLD', DEFAULT_LEVELS);
    if (!result.ok) throw new Error(result.error);
    const { pattern } = result;
    expect(pattern).toMatchObject({ source: 'string', periodRows: 2, postingMode: 'single' });
    expect(pattern.cells.map((c) => c.L)).toEqual([0.8, 0.44, 0.8, 0.44, 0.8, 0.44]);
    expect(pattern.cells.every((c) => c.hard && c.hue === undefined && c.chroma === undefined)).toBe(true);
    expect(pattern.cells[0]?.tolerance).toEqual(HARD_TOLERANCE);
  });

  test('середина и контраст — параметры строки', () => {
    const result = stringPattern('LMD', { center: 0.5, contrast: 0.2 });
    if (!result.ok) throw new Error(result.error);
    expect(result.pattern.cells.map((c) => c.L)).toEqual([0.6, 0.5, 0.4]);
    expect(result.pattern.postingMode).toBe('batch');
  });

  test('ошибка разбора — без паттерна', () => {
    expect(stringPattern('LXL/DL', DEFAULT_LEVELS)).toEqual({ ok: false, error: 'Ряд 1, символ 2: «X» — нужен L, M или D.' });
  });
});
