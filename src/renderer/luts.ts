// Импортированные LUT образов в renderer (docs/decisions/0015-lut-import.md): разобранные таблицы по id
// реестра, загружаются из main по требованию. Нужны холсту сетки и редактора, воркерам метрик и проверки
// по кругу. id выводится из содержимого файла, поэтому загруженная таблица не устаревает.
import { create } from 'zustand';
import type { Lut3D } from '@core/lut/lut3d';
import type { Look } from '@core/project/types';
import type { LutFileStatus } from '@shared/ipc';
import { api, useAppStore } from './store';

export type LutEntry = { state: 'loading' } | { state: 'ready'; lut: Lut3D } | { state: 'missing'; error: string };

interface LutStoreState {
  /** Проект, к которому относятся таблицы: при смене проекта всё сбрасывается. */
  dir: string | null;
  byId: Readonly<Record<string, LutEntry>>;
}

export const useLutStore = create<LutStoreState>()(() => ({ dir: null, byId: {} }));

/**
 * Шаг 9 образа сейчас:
 * - none — у образа нет LUT;
 * - loading — таблица ещё едет из main: плитку пока не рисуем, как плитку без прокси;
 * - ready — шаг 9 с этой таблицей;
 * - missing — копия пропала или изменилась: шаг 9 пропускается, образ показывает предупреждение.
 */
export type LookLut =
  | { state: 'none' }
  | { state: 'loading'; id: string }
  | { state: 'ready'; id: string; lut: Lut3D }
  | { state: 'missing'; id: string; error: string };

const NONE: LookLut = { state: 'none' };

export function lookLut(
  look: Look | undefined,
  files: Readonly<Record<string, LutFileStatus>> | undefined,
  byId: Readonly<Record<string, LutEntry>>,
): LookLut {
  const id = look?.importedLut;
  if (id === undefined) return NONE;
  const entry = byId[id];
  if (entry?.state === 'ready') return { state: 'ready', id, lut: entry.lut };
  if (entry?.state === 'missing') return { state: 'missing', id, error: entry.error };
  if (files?.[id] === 'missing') return { state: 'missing', id, error: 'Файла LUT нет в папке luts/ проекта. Импортируйте его ещё раз.' };
  return { state: 'loading', id };
}

/** То же по текущему состоянию сторов: для обработчиков и рендереров вне React. */
export function currentLookLut(look: Look | undefined): LookLut {
  return lookLut(look, useAppStore.getState().snapshot?.luts, useLutStore.getState().byId);
}

/** React: шаг 9 образа с подпиской на оба стора. */
export function useLookLut(look: Look | undefined): LookLut {
  const files = useAppStore((state) => state.snapshot?.luts);
  const byId = useLutStore((state) => state.byId);
  return lookLut(look, files, byId);
}

function setEntry(dir: string, id: string, entry: LutEntry): void {
  const state = useLutStore.getState();
  if (state.dir !== dir) return;
  useLutStore.setState({ byId: { ...state.byId, [id]: entry } });
}

/**
 * Следит за проектом: таблицы образов, чья копия на месте, загружаются по одной на id. Если main
 * сообщил, что копия снова на месте (повторный импорт), таблица загружается заново.
 */
export function connectLuts(): () => void {
  const sync = (previous?: Readonly<Record<string, LutFileStatus>>) => {
    const snapshot = useAppStore.getState().snapshot;
    const dir = snapshot?.dir ?? null;
    if (useLutStore.getState().dir !== dir) useLutStore.setState({ dir, byId: {} });
    if (!snapshot || dir === null) return;
    const { byId } = useLutStore.getState();
    for (const look of snapshot.project.looks) {
      const id = look.importedLut;
      if (id === undefined || snapshot.luts[id] !== 'ok') continue;
      // Пропавшая таблица запрашивается снова, только когда main сообщил, что копия вернулась.
      const entry = byId[id];
      if (entry && !(entry.state === 'missing' && previous?.[id] === 'missing')) continue;
      setEntry(dir, id, { state: 'loading' });
      api.invoke('lut:data', id).then(
        (result) => setEntry(dir, id, result.ok ? { state: 'ready', lut: result.lut } : { state: 'missing', error: result.error }),
        (err: unknown) => setEntry(dir, id, { state: 'missing', error: err instanceof Error ? err.message : String(err) }),
      );
    }
  };
  sync();
  return useAppStore.subscribe((state, prev) => {
    if (state.snapshot !== prev.snapshot) sync(prev.snapshot?.dir === state.snapshot?.dir ? prev.snapshot?.luts : undefined);
  });
}
