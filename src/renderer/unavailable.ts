// Плитки без данных: признаков у них нет и не будет. Превью не построено — оригинал пропал или изменился (ADR 0004),
// или воркер метрик не смог его прочитать. «Анализ», «Подгонка» и «Поправки к цели» называют такие плитки прямо,
// а не пропускают молча и не ждут вечно. Чистые функции без DOM и стора: их проверяют модульные тесты.
import { plural } from '@core/plural';
import type { Project } from '@core/project/types';
import type { AssetStatus } from '@shared/ipc';

/** proxy — превью не построено; metrics — превью есть, но воркер его не прочитал. */
export type NoDataReason = 'proxy' | 'metrics';

export interface NoDataSlot {
  slotId: string;
  /** Позиция в сетке, с нуля. */
  index: number;
  reason: NoDataReason;
}

/**
 * Из слотов candidates — те, чьих признаков не будет, в порядке сетки. failed — слоты, которые воркер не посчитал
 * для нынешних правок (стор метрик). Остальные кандидаты ещё считаются: их здесь нет.
 */
export function unavailableSlots(
  project: Pick<Project, 'slots'>,
  assets: Readonly<Record<string, AssetStatus>> | undefined,
  failed: Readonly<Record<string, string>>,
  candidates: Iterable<string>,
): NoDataSlot[] {
  const wanted = new Set(candidates);
  const result: NoDataSlot[] = [];
  project.slots.forEach((slot, index) => {
    if (!wanted.has(slot.id) || slot.assetId === undefined) return;
    if (assets?.[slot.assetId]?.proxy === 'failed') result.push({ slotId: slot.id, index, reason: 'proxy' });
    else if (failed[slot.id] !== undefined) result.push({ slotId: slot.id, index, reason: 'metrics' });
  });
  return result;
}

const PROXY_TEXT = 'превью не построено — оригинал пропал или изменился';
const METRICS_TEXT = 'превью не читается';

const numbers = (slots: readonly NoDataSlot[]) => slots.map((s) => s.index + 1).join(', ');

/** «позиция 2», «позиции 1, 3» — список, а не число: единственное — только у одной позиции, и у 21 тоже «позиции». */
const positions = (slots: readonly NoDataSlot[]) => `${slots.length === 1 ? 'позиция' : 'позиции'} ${numbers(slots)}`;

/** «у позиции 2», «у позиций 1, 3». */
const atPositions = (slots: readonly NoDataSlot[]) => `у ${slots.length === 1 ? 'позиции' : 'позиций'} ${numbers(slots)}`;

/**
 * «Нет данных для 2 плиток (позиции 1, 3): превью не построено — оригинал пропал или изменился.» Если причины
 * разные — каждая со своими позициями. Позиции — номера в сетке, с единицы. Пустой список — пустая строка.
 */
export function noDataText(slots: readonly NoDataSlot[]): string {
  const n = slots.length;
  if (n === 0) return '';
  const proxy = slots.filter((s) => s.reason === 'proxy');
  const metrics = slots.filter((s) => s.reason === 'metrics');
  const why =
    metrics.length === 0
      ? PROXY_TEXT
      : proxy.length === 0
        ? METRICS_TEXT
        : `${atPositions(proxy)} ${PROXY_TEXT}, ${atPositions(metrics)} ${METRICS_TEXT}`;
  return `Нет данных для ${n} ${plural(n, 'плитки', 'плиток', 'плиток')} (${positions(slots)}): ${why}.`;
}
