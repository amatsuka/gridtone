// Метрики плиток для режимов 5 «Доминанты» и 7 «Отклонение» (docs/decisions/0012-view-modes.md).
// Считает их воркер; здесь — кэш по ассету, кадру, параметрам конвейера и id LUT образа (ADR 0015)
// и пересчёт через 150 мс после правки.
// Метрики — производные данные: в проект и в историю они не попадают.
import { create } from 'zustand';
import type { PipelineParams } from '@core/color/bake';
import type { TileMetrics } from '@core/metrics/tile';
import { createAdjust } from '@core/project/defaults';
import { proxyUrl } from '@shared/cache';
import type { ViewMode } from '@shared/view';
import { lookLut, useLutStore } from './luts';
import { useAppStore } from './store';
import type { MetricsRequest, MetricsResponse, WorkerLut } from './workers/protocol';

const DEBOUNCE_MS = 150;
/** Результатов в кэше: несколько сотен байт каждый. */
const CACHE_LIMIT = 2000;
const NEUTRAL = createAdjust();

interface MetricsState {
  /** Метрики по id слота. Пока новые считаются, у слота остаются прежние. */
  bySlot: Readonly<Record<string, TileMetrics>>;
}

export const useMetricsStore = create<MetricsState>()(() => ({ bySlot: {} }));

export function needsMetrics(mode: ViewMode): boolean {
  return mode === 'dominant' || mode === 'deviation';
}

/** Подписывается на проект и режим просмотра. Воркер создаётся при первом входе в режим 5 или 7. */
export function connectMetrics(): () => void {
  let worker: Worker | null = null;
  /** LUT, уже присланные текущему воркеру. */
  let sentLuts = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const cache = new Map<string, TileMetrics>();
  const pending = new Set<string>();
  /** Ключ, нужный каждому слоту сейчас. */
  let wanted = new Map<string, string>();

  const publish = () => {
    frame = 0;
    const previous = useMetricsStore.getState().bySlot;
    const bySlot: Record<string, TileMetrics> = {};
    for (const [slotId, key] of wanted) {
      const metrics = cache.get(key) ?? previous[slotId];
      if (metrics) bySlot[slotId] = metrics;
    }
    useMetricsStore.setState({ bySlot });
  };
  // Ответы воркера приходят по одному: в стор они уходят не чаще раза в кадр.
  const publishSoon = () => {
    if (!frame) frame = requestAnimationFrame(publish);
  };

  const onMessage = (event: MessageEvent<MetricsResponse>) => {
    const response = event.data;
    pending.delete(response.key);
    if (!response.ok) {
      console.error('Метрики плитки не посчитаны', response.error);
      return;
    }
    cache.set(response.key, response.metrics);
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) break;
      cache.delete(key);
    }
    publishSoon();
  };

  const createWorker = (): Worker => {
    const created = new Worker(new URL('./workers/metrics.worker.ts', import.meta.url), { type: 'module' });
    created.addEventListener('message', onMessage);
    created.addEventListener('error', (event) => console.error('Воркер метрик упал', event.message));
    sentLuts = new Set();
    return created;
  };

  const run = () => {
    timer = undefined;
    const { snapshot, viewMode, showOriginal } = useAppStore.getState();
    if (!snapshot || !needsMetrics(viewMode)) return;
    const { project, assets } = snapshot;
    const ratio = project.grid.ratio;
    const looks = new Map(project.looks.map((look) => [look.id, look]));
    const lutTables = useLutStore.getState().byId;
    wanted = new Map();
    for (const slot of project.slots) {
      const { assetId } = slot;
      if (!assetId || assets[assetId]?.proxy !== 'ready') continue;
      const look = slot.lookId ? looks.get(slot.lookId) : undefined;
      // Шаг 9: пока таблица LUT едет из main, метрики плитки не считаются — как и холст её не рисует.
      const lut = showOriginal ? null : lookLut(look, snapshot.luts, lutTables);
      if (lut?.state === 'loading') continue;
      const lutId = lut?.state === 'ready' ? lut.id : undefined;
      // До/после: метрики исходника, как и холст.
      const params: PipelineParams = showOriginal ? { photo: NEUTRAL } : { photo: slot.adjust, look: look?.adjust };
      // id LUT выводится из содержимого: он определяет таблицу, и ключ остаётся коротким.
      const key = JSON.stringify([assetId, ratio, slot.crop, params, lutId ?? null]);
      wanted.set(slot.id, key);
      const cached = cache.get(key);
      if (cached) {
        // Недавно нужное — в конец, чтобы кэш вытеснял давно не нужное.
        cache.delete(key);
        cache.set(key, cached);
        continue;
      }
      if (pending.has(key)) continue;
      pending.add(key);
      worker ??= createWorker();
      if (lut?.state === 'ready' && !sentLuts.has(lut.id)) {
        const message: WorkerLut = { type: 'lut', id: lut.id, lut: lut.lut };
        worker.postMessage(message);
        sentLuts.add(lut.id);
      }
      const request: MetricsRequest = {
        type: 'tile',
        key,
        assetId,
        url: proxyUrl(assetId, 512),
        crop: slot.crop,
        ratio,
        params,
        ...(lutId === undefined ? {} : { lutId }),
      };
      worker.postMessage(request);
    }
    publish();
  };

  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (!needsMetrics(state.viewMode)) return;
    if (state.viewMode !== prev.viewMode || state.showOriginal !== prev.showOriginal) {
      // Вход в режим и до/после — сразу: обычно всё уже в кэше.
      clearTimeout(timer);
      run();
    } else if (state.snapshot !== prev.snapshot) {
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    }
  });
  // Таблица LUT пришла из main: плитки с этим образом теперь можно посчитать.
  const unsubscribeLuts = useLutStore.subscribe(() => {
    if (!needsMetrics(useAppStore.getState().viewMode)) return;
    clearTimeout(timer);
    run();
  });
  run();

  return () => {
    unsubscribe();
    unsubscribeLuts();
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    worker?.terminate();
  };
}
