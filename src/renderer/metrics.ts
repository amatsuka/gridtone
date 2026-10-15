// Метрики плиток для режимов 5 «Доминанты» и 7 «Отклонение» (docs/decisions/0012-view-modes.md) и вкладки
// «Анализ» (docs/decisions/0018-features-grid-metrics.md): признаки плитки целиком, тон среднего и доминанта.
// Считает их воркер; здесь — кэш по ассету, кадру, параметрам конвейера и id LUT образа (ADR 0015),
// пересчёт через 150 мс после правки, ход «посчитано N из M» и плитки, которые воркер посчитать не смог.
// Метрики — производные данные: в проект и в историю они не попадают.
import { create } from 'zustand';
import type { PipelineParams } from '@core/color/bake';
import type { Lut3D } from '@core/lut/lut3d';
import type { TileMetrics } from '@core/metrics/tile';
import { createAdjust } from '@core/project/defaults';
import { proxyUrl } from '@shared/cache';
import type { ProjectSnapshot } from '@shared/ipc';
import type { ViewMode } from '@shared/view';
import { lookLut, useLutStore, type LutEntry } from './luts';
import { useAppStore, type InspectorTab } from './store';
import type { MetricsRequest, MetricsResponse, WorkerLut } from './workers/protocol';

const DEBOUNCE_MS = 150;
/** Результатов в кэше: около килобайта каждый (признаки с гистограммами и палитрой). */
const CACHE_LIMIT = 2000;
const NEUTRAL = createAdjust();

interface MetricsState {
  /** Метрики по id слота. Пока новые считаются, у слота остаются прежние. */
  bySlot: Readonly<Record<string, TileMetrics>>;
  /** Ключ запроса, по которому посчитаны метрики слота: совпал с нынешним — метрики свежие (поправки, ADR 0021). */
  keys: Readonly<Record<string, string>>;
  /**
   * Слоты, чьи метрики для нынешних правок воркер посчитать не смог (превью не читается), и ключ этого запроса.
   * Прежних метрик у них нет: «Анализ», «Подгонка» и «Поправки к цели» говорят «нет данных», а не ждут.
   */
  failed: Readonly<Record<string, string>>;
  /** Плиток, чьи метрики нужны сейчас (с готовым прокси), сколько из них посчитано для текущих правок и сколько — нет. */
  progress: { done: number; failed: number; total: number };
}

export const useMetricsStore = create<MetricsState>()(() => ({
  bySlot: {},
  keys: {},
  failed: {},
  progress: { done: 0, failed: 0, total: 0 },
}));

/** Вкладки, которым нужен анализ сетки и поправки: «Анализ» и «Цель» (ADR 0023). */
export function analysisTab(tab: InspectorTab): boolean {
  return tab === 'analysis' || tab === 'target';
}

/** Метрики нужны режимам 5 и 7 и открытым вкладкам «Анализ» и «Цель». */
export function needsMetrics({ viewMode, inspectorTab }: { viewMode: ViewMode; inspectorTab: InspectorTab }): boolean {
  return viewMode === 'dominant' || viewMode === 'deviation' || analysisTab(inspectorTab);
}

/** Запрос метрик слота и LUT его образа, если он есть. */
export interface SlotRequest {
  request: MetricsRequest;
  lut?: { id: string; lut: Lut3D };
}

/**
 * Запросы метрик по слотам с готовым прокси, в порядке сетки: ключ кэша — ассет, сетка, кадр, параметры
 * конвейера и id LUT. Пока таблица LUT образа едет из main, слота нет. Их же берут поправки (fixes.ts).
 */
export function slotRequests(
  snapshot: ProjectSnapshot,
  lutTables: Readonly<Record<string, LutEntry>>,
  showOriginal: boolean,
): Map<string, SlotRequest> {
  const { project, assets } = snapshot;
  const ratio = project.grid.ratio;
  const looks = new Map(project.looks.map((look) => [look.id, look]));
  const requests = new Map<string, SlotRequest>();
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
    requests.set(slot.id, lut?.state === 'ready' ? { request, lut: { id: lut.id, lut: lut.lut } } : { request });
  }
  return requests;
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
  /** Ключи, которые воркер посчитать не смог: повторно в этом проекте не просятся — ответ был бы тем же. */
  const failed = new Set<string>();
  /** Ключ, нужный каждому слоту сейчас. */
  let wanted = new Map<string, string>();

  const publish = () => {
    frame = 0;
    const previous = useMetricsStore.getState();
    const bySlot: Record<string, TileMetrics> = {};
    const keys: Record<string, string> = {};
    const failedSlots: Record<string, string> = {};
    let done = 0;
    for (const [slotId, key] of wanted) {
      const fresh = cache.get(key);
      if (fresh) {
        done++;
        bySlot[slotId] = fresh;
        keys[slotId] = key;
      } else if (failed.has(key)) {
        // Прежние метрики — от других правок: выдавать их за нынешние нельзя.
        failedSlots[slotId] = key;
      } else if (previous.bySlot[slotId]) {
        bySlot[slotId] = previous.bySlot[slotId];
        keys[slotId] = previous.keys[slotId] ?? '';
      }
    }
    const failedCount = Object.keys(failedSlots).length;
    useMetricsStore.setState({ bySlot, keys, failed: failedSlots, progress: { done, failed: failedCount, total: wanted.size } });
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
      failed.add(response.key);
      publishSoon();
      return;
    }
    if (response.type !== 'tile') return;
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
    wanted = new Map();
    for (const [slotId, { request, lut }] of slotRequests(snapshot, useLutStore.getState().byId, showOriginal)) {
      const { key } = request;
      wanted.set(slotId, key);
      const cached = cache.get(key);
      if (cached) {
        // Недавно нужное — в конец, чтобы кэш вытеснял давно не нужное.
        cache.delete(key);
        cache.set(key, cached);
        continue;
      }
      if (pending.has(key) || failed.has(key)) continue;
      pending.add(key);
      worker ??= createWorker();
      if (lut && !sentLuts.has(lut.id)) {
        const message: WorkerLut = { type: 'lut', id: lut.id, lut: lut.lut };
        worker.postMessage(message);
        sentLuts.add(lut.id);
      }
      worker.postMessage(request);
    }
    publish();
  };

  const unsubscribe = useAppStore.subscribe((state, prev) => {
    // Другой проект или тот же, открытый заново: превью могли пересобрать — прежние неудачи не в счёт.
    if (state.snapshot?.dir !== prev.snapshot?.dir) failed.clear();
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
