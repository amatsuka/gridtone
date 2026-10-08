// Ритм яркости сетки (docs/spec.md, «Метрики сетки»; docs/decisions/0018-features-grid-metrics.md).
// Карта L по позициям сравнивается с шаблонами: у каждого — доля дисперсии L, которую он объясняет
// (скорректированный R², поэтому шаблон с тремя классами не выигрывает у шаблона с двумя случайно).
// Лучший шаблон — распознанный ритм, если его сила не ниже порога; сетка с малым разбросом — «ровная».

export type RhythmTemplate = 'checker' | 'rows' | 'columns' | 'diagonal' | 'antidiagonal' | 'gradient';
type ClassTemplate = Exclude<RhythmTemplate, 'gradient'>;

/** Порядок перебора; при равной силе выигрывает шаблон с меньшим числом классов, затем — раньше в списке. */
export const RHYTHM_TEMPLATES: readonly RhythmTemplate[] = ['checker', 'rows', 'columns', 'diagonal', 'antidiagonal', 'gradient'];

export const RHYTHM_LABELS: Record<RhythmTemplate, string> = {
  checker: 'Шахматка',
  rows: 'Полосы по строкам',
  columns: 'Полосы по колонкам',
  diagonal: 'Диагональ ↘',
  antidiagonal: 'Диагональ ↙',
  gradient: 'Градиент',
};

/** Анализ сетки — от стольких плиток с L (два ряда): на одном ряду ритм и медианы ничего не значат. */
export const MIN_GRID_TILES = 6;
/** Сила (скорректированный R²), с которой шаблон считается распознанным. */
export const RHYTHM_MIN_STRENGTH = 0.5;
/** Разброс L (стандартное отклонение) ниже этого — сетка «ровная», шаблоны не сравниваются. */
export const FLAT_SPREAD = 0.03;

export interface TemplateFit {
  template: RhythmTemplate;
  /** Скорректированный R², срезанный в 0..1. */
  strength: number;
  /** R² без поправки. */
  r2: number;
  /** Параметров модели сверх общего среднего: занятых классов − 1, у градиента 1. */
  predictors: number;
  /** Градиент: перепад L на позицию в сторону новых постов (к началу сетки). Больше нуля — новые светлее. */
  slope?: number;
}

export type Rhythm =
  | { kind: 'flat'; spread: number; fits: TemplateFit[] }
  | { kind: 'pattern' | 'none'; spread: number; best: TemplateFit; fits: TemplateFit[] };

/**
 * Класс позиции index (0 — верхняя левая, строки по columns) в шаблоне:
 * шахматка — (строка + колонка) mod 2, полосы по строкам — строка mod 2, по колонкам — колонка,
 * диагонали — (колонка ∓ строка) mod 3.
 */
export function templateClass(template: ClassTemplate, index: number, columns: number): number {
  const row = Math.floor(index / columns);
  const column = index % columns;
  switch (template) {
    case 'checker':
      return (row + column) % 2;
    case 'rows':
      return row % 2;
    case 'columns':
      return column;
    case 'diagonal':
      return (((column - row) % 3) + 3) % 3;
    case 'antidiagonal':
      return (column + row) % 3;
  }
}

/** Стандартное отклонение (по генеральной совокупности) значений, не null. */
export function spreadOf(values: readonly (number | null)[]): number {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return 0;
  const mean = known.reduce((sum, v) => sum + v, 0) / known.length;
  return Math.sqrt(known.reduce((sum, v) => sum + (v - mean) ** 2, 0) / known.length);
}

/**
 * values — L по позициям сетки, null — позиция без фото или без признаков (пропуск).
 * null, если позиций с L меньше MIN_GRID_TILES.
 */
export function detectRhythm(values: readonly (number | null)[], columns: number): Rhythm | null {
  const points: { index: number; L: number }[] = [];
  values.forEach((L, index) => {
    if (L !== null) points.push({ index, L });
  });
  if (points.length < MIN_GRID_TILES) return null;

  const mean = points.reduce((sum, p) => sum + p.L, 0) / points.length;
  const total = points.reduce((sum, p) => sum + (p.L - mean) ** 2, 0);
  const spread = Math.sqrt(total / points.length);
  const fits = RHYTHM_TEMPLATES.map((template) =>
    template === 'gradient' ? gradientFit(points, total) : classFit(template, points, total, columns),
  );
  if (spread < FLAT_SPREAD) return { kind: 'flat', spread, fits };

  let best = fits[0] as TemplateFit;
  for (const fit of fits) {
    if (fit.strength > best.strength || (fit.strength === best.strength && fit.predictors < best.predictors)) best = fit;
  }
  return { kind: best.strength >= RHYTHM_MIN_STRENGTH ? 'pattern' : 'none', spread, best, fits };
}

/** Модель «L — среднее своего класса». */
function classFit(template: ClassTemplate, points: readonly { index: number; L: number }[], total: number, columns: number): TemplateFit {
  const sums = new Map<number, { sum: number; count: number }>();
  for (const { index, L } of points) {
    const c = templateClass(template, index, columns);
    const entry = sums.get(c) ?? { sum: 0, count: 0 };
    entry.sum += L;
    entry.count++;
    sums.set(c, entry);
  }
  let residual = 0;
  for (const { index, L } of points) {
    const entry = sums.get(templateClass(template, index, columns)) as { sum: number; count: number };
    residual += (L - entry.sum / entry.count) ** 2;
  }
  return fitOf(template, residual, total, points.length, sums.size - 1);
}

/** Модель «L — прямая по позиции»: позиция в сетке и есть порядок публикации, только обратный. */
function gradientFit(points: readonly { index: number; L: number }[], total: number): TemplateFit {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.index, 0) / n;
  const meanL = points.reduce((sum, p) => sum + p.L, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const { index, L } of points) {
    sxx += (index - meanX) ** 2;
    sxy += (index - meanX) * (L - meanL);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let residual = 0;
  for (const { index, L } of points) residual += (L - (meanL + slope * (index - meanX))) ** 2;
  // Новые посты — в начале сетки: перепад к новым — минус наклон по позиции.
  return { ...fitOf('gradient', residual, total, n, 1), slope: slope === 0 ? 0 : -slope };
}

function fitOf(template: RhythmTemplate, residual: number, total: number, n: number, predictors: number): TemplateFit {
  const r2 = total > 0 ? Math.max(0, 1 - residual / total) : 0;
  const dof = n - predictors - 1;
  const adjusted = predictors === 0 || dof <= 0 ? 0 : 1 - ((1 - r2) * (n - 1)) / dof;
  return { template, strength: Math.min(1, Math.max(0, adjusted)), r2, predictors };
}
