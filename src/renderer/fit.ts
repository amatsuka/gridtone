// «Подогнать текущую сетку» для вкладки «Цель» (docs/decisions/0025-fit.md): fitGrid из core по свежим признакам
// плиток. Признак свежий, если посчитан для нынешних правок: ключ метрик слота совпадает с нынешним запросом
// (как у поправок, fixes.ts). Перестановка по устаревшим признакам переставила бы не то, поэтому, пока у какой-то
// из участвующих плиток признаки не свежие, подгонки нет — «Считаем…». Подгонка — производные данные: в проект
// пишет только «Переставить» (fitTiles в commands.ts). На 90 плитках — миллисекунды, воркер не нужен.
import { useMemo } from 'react';
import type { TileMetrics } from '@core/metrics/tile';
import { fitGrid, type FitResult } from '@core/pattern/fit';
import type { ProjectSnapshot } from '@shared/ipc';
import { useLutStore, type LutEntry } from './luts';
import { slotRequests, useMetricsStore } from './metrics';
import { useAppStore } from './store';

/** Признаки слотов, посчитанные для нынешних правок; остальные — как будто их нет. */
export function freshFeatures(
  snapshot: ProjectSnapshot,
  lutTables: Readonly<Record<string, LutEntry>>,
  bySlot: Readonly<Record<string, TileMetrics>>,
  keys: Readonly<Record<string, string>>,
): Record<string, TileMetrics> {
  const fresh: Record<string, TileMetrics> = {};
  for (const [slotId, { request }] of slotRequests(snapshot, lutTables, false)) {
    const metrics = bySlot[slotId];
    if (metrics && keys[slotId] === request.key) fresh[slotId] = metrics;
  }
  return fresh;
}

/** Подгонка нынешнего проекта; null — проекта нет. Пока удерживается `\`, признаки — исходников: подгонки нет. */
export function useGridFit(): FitResult | null {
  const snapshot = useAppStore((state) => state.snapshot);
  const showOriginal = useAppStore((state) => state.showOriginal);
  const lutTables = useLutStore((state) => state.byId);
  const bySlot = useMetricsStore((state) => state.bySlot);
  const keys = useMetricsStore((state) => state.keys);
  return useMemo(() => {
    if (!snapshot) return null;
    const features = showOriginal ? {} : freshFeatures(snapshot, lutTables, bySlot, keys);
    return fitGrid(snapshot.project, features);
  }, [snapshot, showOriginal, lutTables, bySlot, keys]);
}
