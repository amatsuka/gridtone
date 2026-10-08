// Метрики сетки (docs/spec.md, «Метрики сетки»; docs/decisions/0018-features-grid-metrics.md): карта яркости
// 3 × N, разброс L, контраст соседей, ритм, палитра сетки, точки колеса, гармония (ADR 0019), ожидания плиток
// и выбросы (ADR 0020). Одна чистая функция над проектом и признаками плиток: её вызывают вкладка «Анализ»,
// режим 7, тесты и скрипт `analyze`. Производные данные — в проект и историю не попадают.
import { outliersOf, tileExpectations, type TileExpectation } from '../harmony/outliers';
import { fitHarmony, type Harmony } from '../harmony/templates';
import type { Features, Project, Vec3 } from '../project/types';
import { meanChroma, meanHue } from './features';
import { weightedPalette, type PaletteEntry } from './palette';
import { detectRhythm, spreadOf, type Rhythm } from './rhythm';

/** Цветов в палитре сетки — не больше (spec: 5–7). Близкие сливаются, как в палитре плитки. */
export const GRID_PALETTE_SIZE = 7;

export interface LumaCell {
  index: number;
  row: number;
  column: number;
  slotId: string;
  /** В позиции есть фото (в том числе опубликованное). */
  photo: boolean;
  published: boolean;
  /** Средняя L плитки; null — фото нет или признаки ещё не посчитаны. */
  L: number | null;
}

export interface WheelPoint {
  slotId: string;
  /** Тон среднего цвета, градусы. */
  hue: number;
  /** Хрома среднего цвета — радиус точки. */
  chroma: number;
}

export interface GridMetrics {
  /** Стандартное отклонение L между плитками. */
  spread: number;
  /** Средняя |ΔL| соседних плиток; null — таких пар нет. */
  contrast: { horizontal: number | null; vertical: number | null };
  rhythm: Rhythm;
  palette: PaletteEntry[];
  wheel: WheelPoint[];
  /** Гармония по точкам колеса; у шаблона `tiles[i]` — положение точки `wheel[i]` относительно секторов. */
  harmony: Harmony;
}

export interface GridAnalysis {
  columns: number;
  rows: number;
  /** Карта яркости: по позиции на слот, в порядке сетки. */
  cells: LumaCell[];
  /** Позиций с фото. */
  photos: number;
  /** Из них с посчитанными признаками. */
  measured: number;
  /** null — плиток с признаками меньше MIN_GRID_TILES (rhythm.ts): анализа сетки нет, признаки плиток есть. */
  metrics: GridMetrics | null;
  /**
   * Ожидание и отклонение плиток с признаками, в порядке сетки: от цели позиции или от сетки. Без анализа
   * сетки — только плитки с целью; у остальных ожидания нет (режим 7 — «нет цели»).
   */
  expectations: TileExpectation[];
  /** Выбросы — плитки с отклонением больше допуска, от самого большого. */
  outliers: TileExpectation[];
}

/**
 * Анализ сетки по признакам плиток (ключ — id слота). Опубликованные плитки входят как контекст.
 * Позиции без фото и без признаков — пропуски: в карте пустые, в метриках не участвуют.
 */
export function analyzeGrid(
  project: Pick<Project, 'grid' | 'slots'>,
  features: Readonly<Record<string, Features | undefined>>,
): GridAnalysis {
  const columns = project.grid.columns;
  const cells = project.slots.map((slot, index): LumaCell => {
    const photo = slot.assetId !== undefined && slot.state !== 'empty';
    const f = photo ? features[slot.id] : undefined;
    return {
      index,
      row: Math.floor(index / columns),
      column: index % columns,
      slotId: slot.id,
      photo,
      published: slot.state === 'published',
      L: f ? f.meanL : null,
    };
  });
  const measured = cells.filter((cell) => cell.L !== null);
  const values = cells.map((cell) => cell.L);
  const rhythm = detectRhythm(values, columns);
  const analysis: GridAnalysis = {
    columns,
    rows: Math.ceil(cells.length / columns),
    cells,
    photos: cells.filter((cell) => cell.photo).length,
    measured: measured.length,
    metrics: null,
    expectations: [],
    outliers: [],
  };
  // Ритма нет, когда плиток с L меньше MIN_GRID_TILES: тогда нет и остальных метрик сетки.
  if (!rhythm) return withExpectations(analysis, project, features);

  const tiles = measured.map((cell) => features[cell.slotId] as Features);
  const wheel = measured.map((cell, i): WheelPoint => {
    const f = tiles[i] as Features;
    return { slotId: cell.slotId, hue: meanHue(f.meanA, f.meanB), chroma: meanChroma(f.meanA, f.meanB) };
  });
  analysis.metrics = {
    spread: spreadOf(values),
    contrast: neighborContrast(values, columns),
    rhythm,
    palette: gridPalette(tiles),
    wheel,
    harmony: fitHarmony(wheel),
  };
  return withExpectations(analysis, project, features);
}

function withExpectations(
  analysis: GridAnalysis,
  project: Pick<Project, 'grid' | 'slots'>,
  features: Readonly<Record<string, Features | undefined>>,
): GridAnalysis {
  const expectations = tileExpectations(project, features, analysis.cells, analysis.metrics);
  return { ...analysis, expectations, outliers: outliersOf(expectations) };
}

/** Средняя |ΔL| по парам соседей в строке и в колонке, где у обоих есть L. */
export function neighborContrast(values: readonly (number | null)[], columns: number): GridMetrics['contrast'] {
  let h = 0;
  let hCount = 0;
  let v = 0;
  let vCount = 0;
  values.forEach((L, i) => {
    if (L === null) return;
    const right = i % columns < columns - 1 ? values[i + 1] : undefined;
    if (right !== undefined && right !== null) {
      h += Math.abs(L - right);
      hCount++;
    }
    const below = values[i + columns];
    if (below !== undefined && below !== null) {
      v += Math.abs(L - below);
      vCount++;
    }
  });
  return { horizontal: hCount > 0 ? h / hCount : null, vertical: vCount > 0 ? v / vCount : null };
}

/**
 * Палитра сетки: цвета палитр всех плиток, сведённые k-means в GRID_PALETTE_SIZE цветов. Вес цвета — его доля
 * в палитре плитки, поэтому каждая плитка весит одинаково. Вес хромы уже учтён в долях плитки и второй раз
 * не добавляется.
 */
export function gridPalette(tiles: readonly Pick<Features, 'palette'>[]): PaletteEntry[] {
  const entries = tiles.flatMap((tile) => tile.palette);
  const points = new Float64Array(entries.length * 3);
  const weights = new Float64Array(entries.length);
  entries.forEach((entry, i) => {
    points.set(entry.lab as Vec3, i * 3);
    weights[i] = entry.share;
  });
  return weightedPalette(points, weights, GRID_PALETTE_SIZE);
}
