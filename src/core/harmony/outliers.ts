// Выбросы сетки (docs/spec.md, «Выбросы и исправления»; docs/decisions/0020-outliers.md). У каждой плитки
// с признаками — ожидание: цель позиции (`slot.target`) или, без цели, «соседи» — уровень ритма яркости,
// медианы сетки по температуре и хроме, сектора шаблона гармонии по тону. Отклонение от ожидания — части
// в долях допуска (deviation.ts): больше 1 — причина выброса, худшая часть — значение режима 7.
// Производные данные: в проект и историю не попадают. Опубликованные плитки — контекст: входят в медианы
// и ритм и помечаются выбросом, поправки им не предлагаются (4г).
import type { GridMetrics, LumaCell } from '../metrics/grid';
import {
  targetParts,
  toleranceRatio,
  weightedHueRatio,
  worstRatio,
  type DeviationPart,
  type DeviationReason,
} from '../metrics/deviation';
import { meanHue, temperature } from '../metrics/features';
import { templateClass, type Rhythm } from '../metrics/rhythm';
import type { Features, Project } from '../project/types';

/**
 * Допуски ожидания сетки — у плиток без цели. L и хрома — OKLab; температура — OKLab вдоль оси температуры
 * (features.ts): +20 делений ползунка у серого L 0.6 — около 0.012; тон — градусы за краем сектора шаблона.
 * Стартовые значения, их калибрует ручной чек-лист этапа 4 (`npm run analyze`).
 */
export const GRID_TOLERANCE = { L: 0.06, temperature: 0.01, chroma: 0.01, hue: 10 } as const;

/** Порядок частей и причин. */
export const DEVIATION_REASONS: readonly DeviationReason[] = ['L', 'temperature', 'chroma', 'hue'];

export const REASON_LABELS: Record<DeviationReason, string> = {
  L: 'яркость',
  temperature: 'температура',
  chroma: 'насыщенность',
  hue: 'тон',
};

/** «−0.030»: минус — типографский. */
function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}

/** Значение в единицах причины: L и хрома — OKLab, температура — со знаком, тон — градусы. */
export function formatReasonValue(reason: DeviationReason, value: number): string {
  switch (reason) {
    case 'L':
      return value.toFixed(2);
    case 'temperature':
      return signed(value, 3);
    case 'chroma':
      return value.toFixed(3);
    case 'hue':
      return `${Math.round(value) % 360}°`;
  }
}

/** «яркость 0.70 → 0.83»: было → ожидается. */
export function formatPart(part: DeviationPart): string {
  const { reason } = part;
  return `${REASON_LABELS[reason]} ${formatReasonValue(reason, part.value)} → ${formatReasonValue(reason, part.expected)}`;
}

/** Откуда ожидание: цель позиции или сетка. */
export type ExpectationSource = 'target' | 'grid';
/** Откуда ожидание L у плитки без цели: медиана её класса ритма, прямая градиента, медиана сетки. */
export type LumaBasis = 'class' | 'gradient' | 'median';

export interface TileExpectation {
  slotId: string;
  /** Позиция в сетке. */
  index: number;
  source: ExpectationSource;
  /** Только у ожидания сетки: откуда ожидание L. */
  basis?: LumaBasis;
  published: boolean;
  /** Проверяемые части в порядке DEVIATION_REASONS: у цели — L и то, что она задаёт; у сетки — все, тон — если есть шаблон. */
  parts: DeviationPart[];
  /** Худшая часть — значение режима 7: 0 — в ожидании, 1 — край допуска. */
  deviation: number;
  /** Части больше допуска — причины выброса, от худшей. Пусто — плитка в допуске. */
  reasons: DeviationPart[];
}

/**
 * Ожидание и отклонение каждой плитки с признаками, в порядке сетки. Плитка с целью — от цели (как режим 7
 * в ADR 0012); без цели — от сетки, если есть анализ сетки (metrics, от 6 плиток); иначе ожидания нет.
 * cells — карта яркости analyzeGrid: L плиток с признаками, null — пропуск.
 */
export function tileExpectations(
  project: Pick<Project, 'grid' | 'slots'>,
  features: Readonly<Record<string, Features | undefined>>,
  cells: readonly LumaCell[],
  metrics: GridMetrics | null,
): TileExpectation[] {
  const measured = cells.filter((cell): cell is LumaCell & { L: number } => cell.L !== null);
  const tiles = measured.map((cell) => {
    const f = features[cell.slotId] as Features;
    return { cell, f, temperature: temperature(f.meanA, f.meanB) };
  });
  const wheelIndex = new Map(metrics?.wheel.map((point, i) => [point.slotId, i]));

  return tiles.flatMap(({ cell, f, temperature: T }, i): TileExpectation[] => {
    const slot = project.slots[cell.index];
    const base = { slotId: cell.slotId, index: cell.index, published: cell.published };
    if (slot?.target) {
      const parts = targetParts({ meanL: f.meanL, meanC: f.meanC, hue: meanHue(f.meanA, f.meanB) }, slot.target);
      return [finish({ ...base, source: 'target' }, parts)];
    }
    if (!metrics) return [];

    const others = tiles.filter((_, j) => j !== i);
    const luma = expectedL(cell, others.map((t) => t.cell), metrics.rhythm, project.grid.columns);
    const expectedT = median(others.map((t) => t.temperature));
    const expectedC = median(others.map((t) => t.f.meanC));
    const parts: DeviationPart[] = [
      part('L', f.meanL, luma.L, GRID_TOLERANCE.L),
      part('temperature', T, expectedT, GRID_TOLERANCE.temperature),
      part('chroma', f.meanC, expectedC, GRID_TOLERANCE.chroma),
    ];
    const { harmony, wheel } = metrics;
    const w = wheelIndex.get(cell.slotId);
    if (harmony.kind === 'template' && w !== undefined) {
      const point = wheel[w] as GridMetrics['wheel'][number];
      const hue = harmony.tiles[w] as (typeof harmony.tiles)[number];
      // Тон без веса (хрома среднего ниже порога гармонии) не проверяется, как и на колесе.
      const ratio = hue.weight > 0 ? weightedHueRatio(hue.distance, GRID_TOLERANCE.hue, point.chroma) : 0;
      parts.push({
        reason: 'hue',
        value: point.hue,
        expected: hue.distance > 0 ? hue.edge : point.hue,
        tolerance: GRID_TOLERANCE.hue,
        ratio,
      });
    }
    return [finish({ ...base, source: 'grid', basis: luma.basis }, parts)];
  });
}

/** Выбросы — плитки с причинами, от самого большого отклонения; при равном — по порядку сетки. */
export function outliersOf(expectations: readonly TileExpectation[]): TileExpectation[] {
  return expectations.filter((e) => e.reasons.length > 0).sort((a, b) => b.deviation - a.deviation || a.index - b.index);
}

function finish(base: Omit<TileExpectation, 'parts' | 'deviation' | 'reasons'>, parts: DeviationPart[]): TileExpectation {
  parts.sort((a, b) => DEVIATION_REASONS.indexOf(a.reason) - DEVIATION_REASONS.indexOf(b.reason));
  const reasons = parts.filter((p) => p.ratio > 1).sort((a, b) => b.ratio - a.ratio);
  return { ...base, parts, deviation: worstRatio(parts), reasons };
}

function part(reason: DeviationReason, value: number, expected: number, tolerance: number): DeviationPart {
  return { reason, value, expected, tolerance, ratio: toleranceRatio(value - expected, tolerance) };
}

/**
 * Ожидание L плитки без цели — по другим плиткам, сама она не входит:
 * - ритм распознан, шаблон с классами — медиана её класса; в классе больше никого — медиана сетки;
 * - градиент — прямая L по позиции через остальные плитки, в её позиции;
 * - ритма нет («не распознан» или «ровная») — медиана сетки.
 */
export function expectedL(
  cell: Pick<LumaCell, 'index'>,
  others: readonly Pick<LumaCell, 'index' | 'L'>[],
  rhythm: Rhythm,
  columns: number,
): { L: number; basis: LumaBasis } {
  const known = others.filter((o): o is { index: number; L: number } => o.L !== null);
  const all = known.map((o) => o.L);
  if (rhythm.kind === 'pattern') {
    const { template } = rhythm.best;
    if (template === 'gradient') {
      const line = lineAt(known, cell.index);
      if (line !== null) return { L: line, basis: 'gradient' };
    } else {
      const own = templateClass(template, cell.index, columns);
      const mates = known.filter((o) => templateClass(template, o.index, columns) === own).map((o) => o.L);
      if (mates.length > 0) return { L: median(mates), basis: 'class' };
    }
  }
  return { L: median(all), basis: 'median' };
}

/** Прямая наименьших квадратов L по позиции через точки, в позиции x; null — меньше двух разных позиций. */
function lineAt(points: readonly { index: number; L: number }[], x: number): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, p) => sum + p.index, 0) / n;
  const meanL = points.reduce((sum, p) => sum + p.L, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const { index, L } of points) {
    sxx += (index - meanX) ** 2;
    sxy += (index - meanX) * (L - meanL);
  }
  if (sxx === 0) return null;
  return meanL + (sxy / sxx) * (x - meanX);
}

/** Медиана; у чётного числа — среднее двух средних. Пусто — 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
