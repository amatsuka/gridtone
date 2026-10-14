// Стоимость попадания фото в цель позиции (docs/spec.md, «Модуль 4», «Подогнать текущую сетку», и «Модуль 5»,
// «Стоимость кандидата»; docs/decisions/0025-fit.md). Формула модуля 5 без палитры и штрафов:
//   cost = |ΔL| / τL + w · Δтона / τтона + |ΔC| / τC,   w = min(1, C / 0.05)
// Вес тона — тот же, что у отклонения режима 7 (ADR 0012): тон почти серой плитки — шум. Части тона и хромы —
// только если цель их задаёт. Части — те же, что у отклонения (`targetParts`), но складываются, а не берётся
// худшая: назначение сравнивает суммы. Единственное место расчёта стоимости: её возьмёт подбор этапа 6.
import { targetParts } from '../metrics/deviation';
import { meanHue } from '../metrics/features';
import type { Features, SlotTarget } from '../project/types';

/** Средние плитки, из которых считается стоимость: L, средняя хрома пикселей, тон среднего (a, b). */
export interface CostStats {
  meanL: number;
  meanC: number;
  hue: number;
}

/** Части стоимости в долях допуска; тон — с весом хромы. Нет части в цели — 0. */
export interface CostParts {
  L: number;
  hue: number;
  chroma: number;
}

/**
 * Потолок части, в допусках. Нулевой допуск даёт бесконечное отклонение (ADR 0012), а назначению нужны конечные
 * числа: промах мимо цели с нулевым допуском стоит 1000 допусков — дороже любого настоящего.
 */
export const COST_PART_MAX = 1000;

/** Средние из признаков плитки — так же, как их берут выбросы (outliers.ts). */
export function costStats(features: Pick<Features, 'meanL' | 'meanA' | 'meanB' | 'meanC'>): CostStats {
  return { meanL: features.meanL, meanC: features.meanC, hue: meanHue(features.meanA, features.meanB) };
}

export function costParts(stats: CostStats, target: SlotTarget): CostParts {
  const parts: CostParts = { L: 0, hue: 0, chroma: 0 };
  for (const part of targetParts(stats, target)) parts[part.reason as keyof CostParts] = Math.min(COST_PART_MAX, part.ratio);
  return parts;
}

/** Стоимость фото в цели: 0 — ровно в цели, 1 — одна величина на краю допуска. */
export function targetCost(stats: CostStats, target: SlotTarget): number {
  const { L, hue, chroma } = costParts(stats, target);
  return L + hue + chroma;
}
