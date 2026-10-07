// Единый контракт IPC. Любой новый канал объявляется здесь и только здесь.
import type { ProjectPatch } from '@core/project/patch';
import type { AssetRef, Project } from '@core/project/types';
import type { ViewMode } from './view';

// ─── renderer ↔ main ────────────────────────────────────────────────────────

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface AssetStatus {
  proxy: 'ready' | 'pending' | 'failed';
  original: 'ok' | 'missing' | 'changed';
}

export interface SaveStatus {
  state: SaveState;
  error?: string;
}

/** Состояние открытого проекта. main владеет проектом, renderer получает снимки. */
export interface ProjectSnapshot {
  dir: string;
  project: Project;
  assets: Record<string, AssetStatus>;
  save: SaveStatus;
  /** Номер последнего пакета патчей из renderer, который уже вошёл в project. */
  patchSeq: number;
}

/** После правки из renderer main шлёт только это: сам проект renderer уже знает. */
export interface ProjectStatus {
  dir: string;
  save: SaveStatus;
  /** Как в ProjectSnapshot: пакеты до этого номера включительно main уже применил. */
  patchSeq: number;
}

/**
 * Правка проекта из renderer (docs/decisions/0008-edit-flow.md): патчи Immer к слотам и образам,
 * которые main проверяет по инвариантам (docs/decisions/0010-patch-invariants.md).
 * seq растёт с каждым пакетом; dir не даёт применить пакет к проекту, открытому после отправки.
 */
export interface PatchBatch {
  dir: string;
  seq: number;
  patches: ProjectPatch[];
}

/**
 * Команда из меню приложения (docs/decisions/0011-undo-history.md). Те же сочетания renderer ловит сам;
 * меню срабатывает, только если страница сочетание не обработала, или по клику мышью.
 * `view:<режим>` — пункты меню «Вид» (docs/decisions/0012-view-modes.md): клавиши 1–7 у них только подписи.
 */
export type MenuCommand = 'undo' | 'redo' | 'selectAll' | 'copyAdjust' | 'pasteAdjust' | `view:${ViewMode}`;

export interface ImportProgress {
  jobId: string;
  total: number;
  done: number;
  added: number;
  duplicates: number;
  errors: { path: string; message: string }[];
  finished: boolean;
}

export interface InvokeMap {
  /** Спросить папку диалогом и создать в ней проект. null — отменено или ошибка (main её уже показал). */
  'project:create': { args: []; result: ProjectSnapshot | null };
  /** Открыть проект из папки; без аргумента — через диалог. */
  'project:open': { args: [dir?: string]; result: ProjectSnapshot | null };
  'project:get': { args: []; result: ProjectSnapshot | null };
  /** Записать несохранённые изменения, не дожидаясь автосохранения. */
  'project:save': { args: []; result: void };
  'project:close': { args: []; result: void };
  /** Применить правки renderer. Бросает, если патч запрещён или проект уже другой. */
  'project:patch': { args: [batch: PatchBatch]; result: void };
  /** Импортировать фото; без аргумента — через диалог. null — нет проекта или отменено. */
  'assets:import': { args: [paths?: string[]]; result: { jobId: string } | null };
}

export interface EventMap {
  'project:changed': ProjectSnapshot | null;
  'project:status': ProjectStatus;
  'import:progress': ImportProgress;
  'menu:command': MenuCommand;
}

export type InvokeChannel = keyof InvokeMap;
export type InvokeArgs<K extends InvokeChannel> = InvokeMap[K]['args'];
export type InvokeResult<K extends InvokeChannel> = InvokeMap[K]['result'];
export type EventChannel = keyof EventMap;

// Белые списки для preload. satisfies не даёт забыть канал или добавить лишний.
const invokeChannels = {
  'project:create': true,
  'project:open': true,
  'project:get': true,
  'project:save': true,
  'project:close': true,
  'project:patch': true,
  'assets:import': true,
} satisfies Record<InvokeChannel, true>;

const eventChannels = {
  'project:changed': true,
  'project:status': true,
  'import:progress': true,
  'menu:command': true,
} satisfies Record<EventChannel, true>;

export const INVOKE_CHANNELS = Object.keys(invokeChannels) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(eventChannels) as EventChannel[];

/** То, что preload кладёт в window.gridtone. */
export interface GridtoneApi {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>>;
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void;
}

// ─── main ↔ indexer (utility process) ───────────────────────────────────────

export interface IndexItem {
  path: string;
  /** Для пересборки прокси: если содержимое изменилось, прокси не строятся. */
  expectHash?: string;
}

export interface IndexJob {
  type: 'index';
  jobId: string;
  cacheDir: string;
  items: IndexItem[];
}

export type IndexerRequest = IndexJob;

export type IndexedAsset = Omit<AssetRef, 'importedAt'>;

export type IndexErrorCode = 'unsupported' | 'hash-mismatch' | 'failed';

export type IndexerResponse =
  | { type: 'item'; jobId: string; index: number; ok: true; asset: IndexedAsset }
  | { type: 'item'; jobId: string; index: number; ok: false; code: IndexErrorCode; error: string }
  | { type: 'done'; jobId: string };
