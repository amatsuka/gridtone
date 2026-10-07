// Единый контракт IPC. Любой новый канал объявляется здесь и только здесь.
import type { PipelineParams } from '@core/color/bake';
import type { LutExportSize } from '@core/lut/verify';
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
export type MenuCommand = 'undo' | 'redo' | 'selectAll' | 'copyAdjust' | 'pasteAdjust' | 'export' | `view:${ViewMode}`;

export interface ImportProgress {
  jobId: string;
  total: number;
  done: number;
  added: number;
  duplicates: number;
  errors: { path: string; message: string }[];
  finished: boolean;
}

/** Раздел LUT в запросе экспорта (docs/decisions/0014-lut-export.md). */
export interface LutExportRequest {
  /** Образы и размер решётки `.cube` у каждого: 33 или 65, по проверке по кругу в диалоге. */
  looks: { id: string; size: LutExportSize }[];
  cube: boolean;
  /** HaldCLUT уровня 8, PNG 16 бит: размер решётки у него всегда 64³. */
  hald: boolean;
}

/** Экран «Экспорт». Разделы добавляются по подэтапам этапа 3; папку спрашивает main. */
export interface ExportRequest {
  /** Проект, из которого экспортируем: если открыт уже другой, экспорт не начнётся. */
  dir: string;
  lut?: LutExportRequest;
}

export interface ExportStarted {
  jobId: string;
  /** Новая подпапка экспорта: каждый экспорт пишет в свою, ничего не перезаписывая. */
  dir: string;
}

export interface ExportProgress {
  jobId: string;
  dir: string;
  /** Файлов в задаче. */
  total: number;
  done: number;
  /** Записанные файлы, имена внутри dir, в порядке записи. */
  files: string[];
  errors: { file: string; message: string }[];
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
  /** Спросить папку и начать экспорт в новую подпапку; ход — событием export:progress. null — отменено. */
  'export:run': { args: [request: ExportRequest]; result: ExportStarted | null };
}

export interface EventMap {
  'project:changed': ProjectSnapshot | null;
  'project:status': ProjectStatus;
  'import:progress': ImportProgress;
  'export:progress': ExportProgress;
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
  'export:run': true,
} satisfies Record<InvokeChannel, true>;

const eventChannels = {
  'project:changed': true,
  'project:status': true,
  'import:progress': true,
  'export:progress': true,
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

/** LUT одного образа: `.cube` размера size и/или HaldCLUT. Файлы — <fileBase>.cube и <fileBase>.png. */
export interface LutExportItem {
  fileBase: string;
  /** Имя образа: TITLE в `.cube` и подпись в комментарии. */
  title: string;
  params: PipelineParams;
  size: LutExportSize;
  cube: boolean;
  hald: boolean;
}

/** Запекание и запись LUT в utility process. Папка уже создана main; файлы в ней не перезаписываются. */
export interface LutExportJob {
  type: 'export-lut';
  jobId: string;
  dir: string;
  items: LutExportItem[];
}

export type IndexerRequest = IndexJob | LutExportJob;

export type IndexedAsset = Omit<AssetRef, 'importedAt'>;

export type IndexErrorCode = 'unsupported' | 'hash-mismatch' | 'failed';

export type IndexerResponse =
  | { type: 'item'; jobId: string; index: number; ok: true; asset: IndexedAsset }
  | { type: 'item'; jobId: string; index: number; ok: false; code: IndexErrorCode; error: string }
  /** Экспорт: файл записан (ok) или не записан; file — имя внутри папки задачи. */
  | { type: 'file'; jobId: string; file: string; ok: true }
  | { type: 'file'; jobId: string; file: string; ok: false; error: string }
  | { type: 'done'; jobId: string };
