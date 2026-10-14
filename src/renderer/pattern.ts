// Черновик паттерна во вкладке «Цель» (docs/decisions/0023-patterns.md): источник, параметры генератора, строка,
// середина и контраст уровней. Это состояние интерфейса: в проект «Применить к сетке» пишет только клетки
// паттерна и цели позиций (applyPatternToGrid в commands.ts). Клетки считает core.
import { DEFAULT_GENERATOR, generatePattern, type GeneratorParams } from '@core/pattern/generator';
import { DEFAULT_LEVELS, type LevelParams } from '@core/pattern/levels';
import { targetLab } from '@core/pattern/pattern';
import { stringPattern } from '@core/pattern/string';
import { labToSrgb8 } from '@core/metrics/tile';
import type { Pattern, SlotTarget } from '@core/project/types';

export type PatternSource = 'generator' | 'string';

export interface PatternDraft {
  source: PatternSource;
  /** Середина и контраст уровней — общие для генератора и строки. */
  levels: LevelParams;
  generator: GeneratorParams;
  /** Строка-шаблон, как её ввели. */
  text: string;
}

export const DEFAULT_PATTERN_DRAFT: PatternDraft = {
  source: 'generator',
  levels: DEFAULT_LEVELS,
  generator: DEFAULT_GENERATOR,
  text: 'LDL/DLD',
};

/** Паттерн черновика или ошибка строки. */
export function draftPattern(draft: PatternDraft): { ok: true; pattern: Pattern } | { ok: false; error: string } {
  if (draft.source === 'string') return stringPattern(draft.text, draft.levels);
  return { ok: true, pattern: generatePattern(draft.generator, draft.levels) };
}

/** Цвет образца цели на экране: OKLab цели со срезом в охват sRGB; без тона — серый той же L. */
export function targetCss(target: Pick<SlotTarget, 'L' | 'hue' | 'chroma'>): string {
  const [r, g, b] = labToSrgb8(targetLab(target));
  return `rgb(${r} ${g} ${b})`;
}
