// Анализ сетки для вкладки «Анализ» и режима 7 (docs/decisions/0018-features-grid-metrics.md, 0020-outliers.md):
// analyzeGrid из core по признакам плиток из стора метрик. Один расчёт на пару «проект, признаки»: вкладка
// и сетка берут один и тот же результат, а гармония на 90 плитках не считается дважды. В проект не пишется.
import { useMemo } from 'react';
import { analyzeGrid, type GridAnalysis } from '@core/metrics/grid';
import type { TileMetrics } from '@core/metrics/tile';
import type { Project } from '@core/project/types';
import { useMetricsStore } from './metrics';

let last: { project: Project; bySlot: Readonly<Record<string, TileMetrics>>; analysis: GridAnalysis } | null = null;

/** Анализ сетки; тот же проект и те же признаки — прежний результат. */
export function gridAnalysis(project: Project, bySlot: Readonly<Record<string, TileMetrics>>): GridAnalysis {
  if (last?.project === project && last.bySlot === bySlot) return last.analysis;
  const analysis = analyzeGrid(project, bySlot);
  last = { project, bySlot, analysis };
  return analysis;
}

export function useGridAnalysis(project: Project): GridAnalysis {
  const bySlot = useMetricsStore((state) => state.bySlot);
  return useMemo(() => gridAnalysis(project, bySlot), [project, bySlot]);
}
