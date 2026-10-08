// Поправки выбросов для раздела «Выбросы» вкладки «Анализ» (docs/decisions/0021-fixes.md). Поправку считает
// findFix из core во втором экземпляре воркера метрик: метрики после правки не ждут поиска. Просятся они только
// по свежим признакам всей сетки — иначе ожидание посчитано по прежним правкам — и только для неопубликованных
// выбросов, пока открыта вкладка «Анализ». Кэш — по ключу метрик слота и цели поправки.
// Поправки — производные данные: в проект пишет только «Применить» (applyTileFix в commands.ts).
import { create } from 'zustand';
import type { FixTarget, TileFix } from '@core/harmony/fixes';
import { gridAnalysis } from './analysis';
import { useLutStore } from './luts';
import { slotRequests, useMetricsStore } from './metrics';
import { useAppStore } from './store';
import type { FixRequest, MetricsResponse, WorkerLut } from './workers/protocol';

/** Поправок в кэше: по одной на выброс и его ожидание, каждая — пара сотен байт. */
const CACHE_LIMIT = 500;

/** Поправка слота сейчас: считается, готова или не посчитана. Нет записи — поправку не просили. */
export type FixEntry = { state: 'pending' } | { state: 'ready'; fix: TileFix } | { state: 'error' };

interface FixState {
  bySlot: Readonly<Record<string, FixEntry>>;
}

export const useFixStore = create<FixState>()(() => ({ bySlot: {} }));

export function connectFixes(): () => void {
  let worker: Worker | null = null;
  let sentLuts = new Set<string>();
  const cache = new Map<string, TileFix>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  /** Ключ поправки, нужной каждому слоту сейчас. */
  let wanted = new Map<string, string>();

  const publish = () => {
    const bySlot: Record<string, FixEntry> = {};
    for (const [slotId, key] of wanted) {
      const fix = cache.get(key);
      bySlot[slotId] = fix ? { state: 'ready', fix } : failed.has(key) ? { state: 'error' } : { state: 'pending' };
    }
    // Тот же результат — без нового объекта: раздел «Выбросы» не перерисовывается на каждом кадре метрик.
    const previous = useFixStore.getState().bySlot;
    const same =
      Object.keys(previous).length === wanted.size &&
      Object.entries(bySlot).every(([slotId, entry]) => {
        const old = previous[slotId];
        return old?.state === entry.state && (entry.state !== 'ready' || (old.state === 'ready' && old.fix === entry.fix));
      });
    if (!same) useFixStore.setState({ bySlot });
  };

  const onMessage = (event: MessageEvent<MetricsResponse>) => {
    const response = event.data;
    pending.delete(response.key);
    if (!response.ok) {
      console.error('Поправка не посчитана', response.error);
      failed.add(response.key);
    } else if (response.type === 'fix') {
      cache.set(response.key, response.fix);
      for (const key of cache.keys()) {
        if (cache.size <= CACHE_LIMIT) break;
        cache.delete(key);
      }
    }
    if ([...wanted.values()].includes(response.key)) publish();
  };

  const createWorker = (): Worker => {
    const created = new Worker(new URL('./workers/metrics.worker.ts', import.meta.url), { type: 'module' });
    created.addEventListener('message', onMessage);
    created.addEventListener('error', (event) => console.error('Воркер поправок упал', event.message));
    sentLuts = new Set();
    return created;
  };

  const run = () => {
    const { snapshot, showOriginal, inspectorTab } = useAppStore.getState();
    wanted = new Map();
    if (!snapshot || showOriginal || inspectorTab !== 'analysis') return publish();
    const requests = slotRequests(snapshot, useLutStore.getState().byId, false);
    const { bySlot, keys } = useMetricsStore.getState();
    // Ожидание зависит от всех плиток: пока чьи-то признаки не для нынешних правок, поправки не просим.
    for (const [slotId, { request }] of requests) if (keys[slotId] !== request.key) return publish();

    for (const outlier of gridAnalysis(snapshot.project, bySlot).outliers) {
      const reason = outlier.reasons[0];
      const slot = requests.get(outlier.slotId);
      if (outlier.published || !reason || !slot) continue;
      const { value, expected, tolerance } = reason;
      const target: FixTarget = { reason: reason.reason, value, expected, tolerance, source: outlier.source };
      const key = JSON.stringify([slot.request.key, target]);
      wanted.set(outlier.slotId, key);
      if (cache.has(key)) {
        const fix = cache.get(key) as TileFix;
        cache.delete(key);
        cache.set(key, fix);
        continue;
      }
      if (pending.has(key) || failed.has(key)) continue;
      pending.add(key);
      worker ??= createWorker();
      if (slot.lut && !sentLuts.has(slot.lut.id)) {
        const message: WorkerLut = { type: 'lut', id: slot.lut.id, lut: slot.lut.lut };
        worker.postMessage(message);
        sentLuts.add(slot.lut.id);
      }
      const request: FixRequest = { ...slot.request, type: 'fix', key, target };
      worker.postMessage(request);
    }
    publish();
  };

  const unsubscribeApp = useAppStore.subscribe((state, prev) => {
    if (state.snapshot !== prev.snapshot || state.inspectorTab !== prev.inspectorTab || state.showOriginal !== prev.showOriginal) run();
  });
  const unsubscribeMetrics = useMetricsStore.subscribe((state, prev) => {
    if (state.bySlot !== prev.bySlot || state.keys !== prev.keys) run();
  });
  const unsubscribeLuts = useLutStore.subscribe(run);
  run();

  return () => {
    unsubscribeApp();
    unsubscribeMetrics();
    unsubscribeLuts();
    worker?.terminate();
  };
}
