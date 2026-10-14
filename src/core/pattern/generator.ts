// Генератор паттернов (docs/spec.md, «Откуда берётся паттерн»; docs/decisions/0023-patterns.md): шахматка, полосы
// по строкам и колонкам, диагонали, градиент по порядку публикации и чередование двух цветов. Классы позиций —
// как у шаблонов ритма (metrics/rhythm.ts): сгенерированный паттерн ритм узнаёт своим шаблоном. Параметры
// генератора — состояние интерфейса, в проект пишутся только клетки паттерна.
import { TEMPERATURE_AXIS } from '../metrics/features';
import { templateClass } from '../metrics/rhythm';
import type { Pattern, SlotTarget } from '../project/types';
import { hardTarget, levelL, targetColorFromAb, type Level, type LevelParams, type TargetColor } from './levels';
import { makePattern, PATTERN_COLUMNS, PATTERN_MAX_ROWS } from './pattern';

export type GeneratorTemplate = 'checker' | 'rows' | 'columns' | 'diagonal' | 'antidiagonal' | 'gradient' | 'twoColors';

export const GENERATOR_TEMPLATES: readonly GeneratorTemplate[] = [
  'checker',
  'rows',
  'columns',
  'diagonal',
  'antidiagonal',
  'gradient',
  'twoColors',
];

export const GENERATOR_LABELS: Record<GeneratorTemplate, string> = {
  checker: 'Шахматка',
  rows: 'Полосы по строкам',
  columns: 'Полосы по колонкам',
  diagonal: 'Диагональ ↘',
  antidiagonal: 'Диагональ ↙',
  gradient: 'Градиент во времени',
  twoColors: 'Чередование двух цветов',
};

/** Градиент по порядку публикации: новые посты светлее или теплее. */
export type GradientKind = 'lighter' | 'warmer';

export const GRADIENT_LABELS: Record<GradientKind, string> = { lighter: 'Новые светлее', warmer: 'Новые теплее' };

export interface GeneratorParams {
  template: GeneratorTemplate;
  /** Уровней у полос по строкам и колонкам: 2 — L и D, 3 — L, M и D. */
  levels: 2 | 3;
  /** Цвет уровня — по желанию. У градиента цвет задаёт M: «светлее» — всем клеткам, «теплее» — середине сдвига. */
  colors: Partial<Record<Level, TargetColor>>;
  gradient: GradientKind;
  /** Период градиента, рядов. */
  periodRows: number;
  /** Размах «новые теплее» вдоль оси температуры (OKLab): от старой клетки периода до новой. */
  warmth: number;
  /** Два цвета чередования; L обоих — середина. */
  pair: readonly [TargetColor, TargetColor];
}

export const DEFAULT_GENERATOR: GeneratorParams = {
  template: 'checker',
  levels: 2,
  colors: {},
  gradient: 'lighter',
  periodRows: 3,
  warmth: 0.08,
  pair: [
    { hue: 70, chroma: 0.06 },
    { hue: 250, chroma: 0.06 },
  ],
};

/** Пределы размаха «теплее»: 0.02 — едва заметно, 0.16 — от синего до оранжевого. */
export const WARMTH_RANGE: readonly [number, number] = [0.02, 0.16];
/** Хрома, ниже которой у клетки градиента нет тона: ровно серая середина. */
const HUELESS_CHROMA = 1e-4;

/** Последовательность уровней шаблона по классам позиций. */
function levelsOf(params: Pick<GeneratorParams, 'template' | 'levels'>): Level[] {
  switch (params.template) {
    case 'checker':
      return ['L', 'D'];
    case 'rows':
      return params.levels === 2 ? ['L', 'D'] : ['L', 'M', 'D'];
    case 'columns':
      return params.levels === 2 ? ['L', 'D', 'L'] : ['L', 'M', 'D'];
    case 'diagonal':
    case 'antidiagonal':
      return ['L', 'M', 'D'];
    case 'gradient':
      return ['M'];
    case 'twoColors':
      return [];
  }
}

/** Уровни, у которых шаблон может задать цвет, — по порядку L, M, D. */
export function generatorLevels(params: Pick<GeneratorParams, 'template' | 'levels'>): Level[] {
  const used = new Set(levelsOf(params));
  return (['L', 'M', 'D'] as const).filter((level) => used.has(level));
}

/** Рядов в периоде шаблона. */
function periodRowsOf(params: GeneratorParams): number {
  switch (params.template) {
    case 'checker':
    case 'twoColors':
      return 2;
    case 'rows':
      return params.levels;
    case 'columns':
      return 1;
    case 'diagonal':
    case 'antidiagonal':
      return 3;
    case 'gradient':
      return Math.min(PATTERN_MAX_ROWS, Math.max(1, Math.round(params.periodRows)));
  }
}

/** Клетки периода по рядам, слева направо. */
export function generateCells(params: GeneratorParams, levels: LevelParams): SlotTarget[] {
  const q = PATTERN_COLUMNS * periodRowsOf(params);
  const sequence = levelsOf(params);
  const level = (lvl: Level) => hardTarget(levelL(lvl, levels), params.colors[lvl]);
  return Array.from({ length: q }, (_, i): SlotTarget => {
    const row = Math.floor(i / PATTERN_COLUMNS);
    const column = i % PATTERN_COLUMNS;
    switch (params.template) {
      case 'checker':
        return level(sequence[templateClass('checker', i, PATTERN_COLUMNS)] as Level);
      case 'rows':
        return level(sequence[row] as Level);
      case 'columns':
        return level(sequence[column] as Level);
      case 'diagonal':
      case 'antidiagonal':
        return level(sequence[templateClass(params.template, i, PATTERN_COLUMNS)] as Level);
      case 'twoColors':
        return hardTarget(levelL('M', levels), params.pair[templateClass('checker', i, PATTERN_COLUMNS)]);
      case 'gradient':
        return gradientCell(params, levels, i / Math.max(1, q - 1));
    }
  });
}

/**
 * Клетка градиента: t = 0 у новой (левой верхней) клетки периода, 1 — у старой. «Светлее» — L от уровня L к D,
 * цвет M у всех; «теплее» — L середины, цвет M (или серый) сдвигается вдоль оси температуры от +warmth/2 к −warmth/2.
 */
function gradientCell(params: GeneratorParams, levels: LevelParams, t: number): SlotTarget {
  const base = params.colors.M;
  if (params.gradient === 'lighter') {
    const light = levelL('L', levels);
    const dark = levelL('D', levels);
    return hardTarget(light + (dark - light) * t, base);
  }
  // Цвет середины в (a, b); без тона — серый.
  const rad = ((base?.hue ?? 0) * Math.PI) / 180;
  const chroma = base?.hue === undefined ? 0 : base.chroma;
  const shift = params.warmth / 2 - params.warmth * t;
  const a = chroma * Math.cos(rad) + shift * TEMPERATURE_AXIS[0];
  const b = chroma * Math.sin(rad) + shift * TEMPERATURE_AXIS[1];
  return hardTarget(levelL('M', levels), targetColorFromAb(a, b, HUELESS_CHROMA));
}

export function generatePattern(params: GeneratorParams, levels: LevelParams): Pattern {
  return makePattern('generator', generateCells(params, levels));
}
