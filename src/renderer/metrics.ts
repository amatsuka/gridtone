// Метрики плиток для режимов 5 «Доминанты» и 7 «Отклонение» (docs/decisions/0012-view-modes.md) и вкладки
// «Анализ» (docs/decisions/0018-features-grid-metrics.md): признаки плитки целиком, тон среднего и доминанта.
// Считает их воркер; здесь — кэш по ассету, кадру, параметрам конвейера и id LUT образа (ADR 0015),
// пересчёт через 150 мс после правки и ход «посчитано N из M».
// Метрики — производные данные: в проект и в историю они не попадают.
import { create } from 'zustand';
import type { PipelineParams } from '@core/color/bake';
import type { TileMetrics } from '@core/metrics/tile';
import { createAdjust } from '@core/project/defaults';
import { proxyUrl } from '@shared/cache';
import type { ViewMode } from '@shared/view';
import { lookLut, useLutStore } from './luts';
import { useAppStore, type InspectorTab } from './store';
import type { MetricsRequest, MetricsResponse, WorkerLut } from './workers/protocol';

const DEBOUNCE_MS = 150;
/** Результатов в кэше: около килобайта каждый (признаки с гистограммами и палитрой). */
const CACHE_LIMIT = 2000;
const NEUTRAL = createAdjust();

interface MetricsState {
  /** Метрики по id слота. Пока новые считаются, у слота остаются прежние. */
  bySlot: Readonly<Record<string, TileMetrics>>;
  /** Плиток, чьи метрики нужны сейчас (с готовым прокси), и сколько из них уже посчитано для текущих правок. */
  progress: { done: number; total: number };
}

export const useMetricsStore = create<MetricsState>()(() => ({ bySlot: {}, progress: { done: 0, total: 0 } }));

/** Метрики нужны режимам 5 и 7 и открытой вкладке «Анализ». */
export function needsMetrics({ viewMode, inspectorTab }: { viewMode: ViewMode; inspectorTab: InspectorTab }): boolean {
  return viewMode === 'dominant' || viewMode === 'deviation' || inspectorTab === 'analysis';
}

/** Подписывается на проект, режим просмотра и вкладку. Воркер создаётся, когда метрики понадобились впервые. */
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
    let done = 0;
    for (const [slotId, key] of wanted) {
      const fresh = cache.get(key);
      if (fresh) done++;
      const metrics = fresh ?? previous[slotId];
      if (metrics) bySlot[slotId] = metrics;
    }
    useMetricsStore.setState({ bySlot, progress: { done, total: wanted.size } });
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
    const state = useAppStore.getState();
    const { snapshot, showOriginal } = state;
    if (!snapshot || !needsMetrics(state)) return;
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
    if (!needsMetrics(state)) return;
    if (state.viewMode !== prev.viewMode || state.inspectorTab !== prev.inspectorTab || state.showOriginal !== prev.showOriginal) {
      // Вход в режим, на вкладку «Анализ» и до/после — сразу: обычно всё уже в кэше.
      clearTimeout(timer);
      run();
    } else if (state.snapshot !== prev.snapshot) {
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    }
  });
  // Таблица LUT пришла из main: плитки с этим образом теперь можно посчитать.
  const unsubscribeLuts = useLutStore.subscribe(() => {
    if (!needsMetrics(useAppStore.getState())) return;
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
