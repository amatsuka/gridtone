import { describe, expect, test } from 'vitest';
import { hueDistance } from '@core/color/math';
import { TEMPERATURE_AXIS, temperature } from '@core/metrics/features';
import { detectRhythm, templateClass, type RhythmTemplate } from '@core/metrics/rhythm';
import type { Pattern } from '@core/project/types';
import {
  DEFAULT_GENERATOR,
  generatePattern,
  generatorLevels,
  GENERATOR_TEMPLATES,
  type GeneratorParams,
} from '@core/pattern/generator';
import { DEFAULT_LEVELS, HARD_TOLERANCE } from '@core/pattern/levels';
import { targetAt, targetLab } from '@core/pattern/pattern';

const generate = (params: Partial<GeneratorParams>, levels = DEFAULT_LEVELS): Pattern =>
  generatePattern({ ...DEFAULT_GENERATOR, ...params }, levels);
/** L по позициям сетки из rows рядов. */
const gridL = (pattern: Pattern, rows: number) => Array.from({ length: rows * 3 }, (_, i) => targetAt(pattern, i, 0)!.L);
const Ls = (pattern: Pattern) => pattern.cells.map((c) => c.L);

describe('шаблоны генератора и их период', () => {
  test('шахматка — 2 уровня, период 2 ряда', () => {
    const p = generate({ template: 'checker' });
    expect(p).toMatchObject({ source: 'generator', periodRows: 2, postingMode: 'single' });
    expect(Ls(p)).toEqual([0.8, 0.44, 0.8, 0.44, 0.8, 0.44]);
    expect(p.cells.every((c) => c.hard && c.hue === undefined)).toBe(true);
    expect(p.cells[0]?.tolerance).toEqual(HARD_TOLERANCE);
  });

  test('полосы по строкам — 2 или 3 уровня, период — число уровней', () => {
    const two = generate({ template: 'rows', levels: 2 });
    expect(two).toMatchObject({ periodRows: 2, postingMode: 'batch' });
    expect(Ls(two)).toEqual([0.8, 0.8, 0.8, 0.44, 0.44, 0.44]);
    const three = generate({ template: 'rows', levels: 3 });
    expect(three).toMatchObject({ periodRows: 3, postingMode: 'batch' });
    expect(Ls(three)).toEqual([0.8, 0.8, 0.8, 0.62, 0.62, 0.62, 0.44, 0.44, 0.44]);
  });

  test('полосы по колонкам — 2 или 3 уровня, период — ряд', () => {
    expect(Ls(generate({ template: 'columns', levels: 2 }))).toEqual([0.8, 0.44, 0.8]);
    const three = generate({ template: 'columns', levels: 3 });
    expect(three).toMatchObject({ periodRows: 1, postingMode: 'batch' });
    expect(Ls(three)).toEqual([0.8, 0.62, 0.44]);
  });

  test('диагонали — 3 уровня, период 3 ряда; классы — как у ритма', () => {
    for (const template of ['diagonal', 'antidiagonal'] as const) {
      const p = generate({ template });
      expect(p).toMatchObject({ periodRows: 3, postingMode: 'batch' });
      const byClass = [0.8, 0.62, 0.44];
      expect(Ls(p)).toEqual(p.cells.map((_, i) => byClass[templateClass(template, i, 3)]));
    }
  });

  test('чередование двух цветов — шахматкой, L — середина', () => {
    const p = generate({ template: 'twoColors', pair: [{ hue: 70, chroma: 0.06 }, { hue: 250, chroma: 0.05 }] });
    expect(p).toMatchObject({ periodRows: 2, postingMode: 'single' });
    expect(Ls(p)).toEqual(Array(6).fill(0.62));
    expect(p.cells.map((c) => c.hue)).toEqual([70, 250, 70, 250, 70, 250]);
    expect(p.cells.map((c) => c.chroma)).toEqual([0.06, 0.05, 0.06, 0.05, 0.06, 0.05]);
  });

  test('каждый шаблон даёт паттерн с клетками 3 × период', () => {
    for (const template of GENERATOR_TEMPLATES) {
      const p = generate({ template });
      expect(p.cells).toHaveLength(3 * p.periodRows);
    }
  });

  test('цвет уровня — по желанию: тон и хрома в целях только у уровней с цветом', () => {
    const p = generate({ template: 'checker', colors: { L: { hue: 70, chroma: 0.05 } } });
    expect(p.cells.map((c) => c.hue ?? null)).toEqual([70, null, 70, null, 70, null]);
    expect(p.cells[0]).toEqual({ L: 0.8, hue: 70, chroma: 0.05, tolerance: HARD_TOLERANCE, hard: true });
    // С цветом у одного уровня клетки не совпадают при сдвиге — но шахматка остаётся шахматкой.
    expect(p.postingMode).toBe('single');
    const both = generate({ template: 'rows', levels: 3, colors: { L: { hue: 70, chroma: 0.05 }, M: { hue: 200, chroma: 0.04 }, D: { hue: 250, chroma: 0.05 } } });
    expect(both.cells.map((c) => c.hue)).toEqual([70, 70, 70, 200, 200, 200, 250, 250, 250]);
  });

  test('уровни генератора — те, что задают цвет: шахматка — L и D, 3 уровня — L, M, D, два цвета — без уровней', () => {
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'checker' })).toEqual(['L', 'D']);
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'rows', levels: 3 })).toEqual(['L', 'M', 'D']);
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'columns', levels: 2 })).toEqual(['L', 'D']);
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'diagonal' })).toEqual(['L', 'M', 'D']);
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'gradient' })).toEqual(['M']);
    expect(generatorLevels({ ...DEFAULT_GENERATOR, template: 'twoColors' })).toEqual([]);
  });
});

describe('сгенерированные паттерны узнаются ритмом своим шаблоном с силой 1', () => {
  const cases: [Partial<GeneratorParams>, RhythmTemplate][] = [
    [{ template: 'checker' }, 'checker'],
    [{ template: 'rows', levels: 2 }, 'rows'],
    [{ template: 'columns', levels: 2 }, 'columns'],
    [{ template: 'columns', levels: 3 }, 'columns'],
    [{ template: 'diagonal' }, 'diagonal'],
    [{ template: 'antidiagonal' }, 'antidiagonal'],
  ];
  for (const [params, template] of cases) {
    test(`${params.template}${params.levels ? `, ${params.levels} уровня` : ''} → ${template}`, () => {
      for (const rows of [3, 6]) {
        const rhythm = detectRhythm(gridL(generate(params), rows), 3);
        expect(rhythm?.kind).toBe('pattern');
        if (rhythm?.kind !== 'pattern') return;
        expect(rhythm.best.template).toBe(template);
        expect(rhythm.best.strength).toBeCloseTo(1, 10);
      }
    });
  }
});

describe('градиент по порядку публикации', () => {
  test('«новые светлее»: L растёт от старых к новым — от D внизу периода к L вверху', () => {
    const p = generate({ template: 'gradient', gradient: 'lighter', periodRows: 3 });
    expect(p).toMatchObject({ periodRows: 3, postingMode: 'batch' });
    const L = Ls(p);
    expect(L[0]).toBe(0.8);
    expect(L[8]).toBe(0.44);
    for (let i = 1; i < L.length; i++) expect(L[i]!).toBeLessThan(L[i - 1]!);
    const rhythm = detectRhythm(L, 3);
    expect(rhythm?.kind === 'pattern' && rhythm.best).toMatchObject({ template: 'gradient' });
    expect(rhythm?.kind === 'pattern' && rhythm.best.slope! > 0).toBe(true);
  });

  test('период — параметр, по умолчанию 3 ряда', () => {
    expect(DEFAULT_GENERATOR.periodRows).toBe(3);
    expect(generate({ template: 'gradient', periodRows: 2 }).periodRows).toBe(2);
    expect(generate({ template: 'gradient', periodRows: 5 }).cells).toHaveLength(15);
  });

  test('«новые теплее»: L — середина, цвет сдвигается вдоль оси температуры, новые теплее', () => {
    const p = generate({ template: 'gradient', gradient: 'warmer', periodRows: 3, warmth: 0.08 });
    expect(p.postingMode).toBe('batch');
    expect(Ls(p)).toEqual(Array(9).fill(0.62));
    // Температура клетки — её место на оси: от +0.04 у новой до −0.04 у старой, через ноль в середине.
    const temps = p.cells.map((c) => {
      const [, a, b] = targetLab(c);
      return temperature(a, b);
    });
    temps.forEach((t, i) => expect(t).toBeCloseTo(0.04 - 0.01 * i, 3));
    // Крайние клетки — на оси температуры: тёплая по оси, холодная — против неё.
    const axisHue = (Math.atan2(TEMPERATURE_AXIS[1], TEMPERATURE_AXIS[0]) * 180) / Math.PI;
    expect(hueDistance(p.cells[0]!.hue!, axisHue)).toBeLessThan(0.01);
    expect(hueDistance(p.cells[8]!.hue!, axisHue + 180)).toBeLessThan(0.01);
    expect(p.cells[0]!.chroma).toBeCloseTo(0.04, 4);
    // Ровно на нуле тона нет — только хрома 0: «нейтральный».
    expect(p.cells[4]).toMatchObject({ chroma: 0 });
    expect(p.cells[4]!.hue).toBeUndefined();
    expect(p.cells.filter((c) => c.hue === undefined)).toHaveLength(1);
  });

  test('«новые теплее» с цветом середины: сдвиг вокруг него', () => {
    const base = { hue: 200, chroma: 0.06 };
    const p = generate({ template: 'gradient', gradient: 'warmer', warmth: 0.04, colors: { M: base } });
    const middle = p.cells[4]!;
    expect(hueDistance(middle.hue!, 200)).toBeLessThan(0.01);
    expect(middle.chroma).toBeCloseTo(0.06, 4);
    const [, a0, b0] = targetLab(p.cells[0]!);
    const [, a8, b8] = targetLab(p.cells[8]!);
    expect(temperature(a0, b0) - temperature(a8, b8)).toBeCloseTo(0.04, 3);
  });

  test('«новые светлее» с цветом середины — тот же цвет у всех клеток', () => {
    const p = generate({ template: 'gradient', gradient: 'lighter', colors: { M: { hue: 30, chroma: 0.05 } } });
    expect(p.cells.every((c) => c.hue === 30 && c.chroma === 0.05)).toBe(true);
  });
});
