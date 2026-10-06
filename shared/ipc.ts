// Единый контракт IPC. Любой новый канал объявляется здесь и только здесь.
import type { AssetRef, Project } from '@core/project/types';

// ─── renderer ↔ main ────────────────────────────────────────────────────────

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface AssetStatus {
  proxy: 'ready' | 'pending' | 'failed';
  original: 'ok' | 'missing' | 'changed';
}

/** Состояние открытого проекта. main владеет проектом, renderer получает снимки. */
export interface ProjectSnapshot {
  dir: string;
  project: Project;
  assets: Record<string, AssetStatus>;
  save: { state: SaveState; error?: string };
}

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
  /** Импортировать фото; без аргумента — через диалог. null — нет проекта или отменено. */
  'assets:import': { args: [paths?: string[]]; result: { jobId: string } | null };
}

export interface EventMap {
  'project:changed': ProjectSnapshot | null;
  'import:progress': ImportProgress;
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
  'assets:import': true,
} satisfies Record<InvokeChannel, true>;

const eventChannels = {
  'project:changed': true,
  'import:progress': true,
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
