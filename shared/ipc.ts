// Единый контракт IPC. Любой новый канал объявляется здесь и только здесь.
import type { PipelineParams } from '@core/color/bake';
import type { CardReport } from '@core/lut/calibration';
import type { Lut3D } from '@core/lut/lut3d';
import type { LutExportSize } from '@core/lut/verify';
import type { ProjectPatch } from '@core/project/patch';
import type { AssetRef, Crop, Project, Ratio } from '@core/project/types';
import type { ViewMode } from './view';

// ─── renderer ↔ main ────────────────────────────────────────────────────────

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface AssetStatus {
  proxy: 'ready' | 'pending' | 'failed';
  original: 'ok' | 'missing' | 'changed';
}

/** Копия импортированного LUT в luts/ папки проекта: на месте или пропала (docs/decisions/0015-lut-import.md). */
export type LutFileStatus = 'ok' | 'missing';

export interface SaveStatus {
  state: SaveState;
  error?: string;
}

/** Состояние открытого проекта. main владеет проектом, renderer получает снимки. */
export interface ProjectSnapshot {
  dir: string;
  project: Project;
  assets: Record<string, AssetStatus>;
  /** Статус копий LUT по id реестра project.luts. Если копия пропала, шаг 9 пропускается. */
  luts: Record<string, LutFileStatus>;
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
 * Правка проекта из renderer (docs/decisions/0008-edit-flow.md): патчи Immer к слотам, образам и числу
 * закреплённых, которые main проверяет по инвариантам (docs/decisions/0010-patch-invariants.md, 0022).
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
export type MenuCommand =
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'copyAdjust'
  | 'pasteAdjust'
  | 'export'
  | 'importLut'
  | `view:${ViewMode}`;

/** Импорт `.cube` (ADR 0015): новый образ в конце looks или ошибка разбора — тогда проект не меняется. */
export type LutImportResult = { ok: true; lookId: string } | { ok: false; error: string };

/** Разобранный LUT из luts/<id>.cube. Если копии нет или она изменилась — ошибка, шаг 9 пропускается. */
export type LutDataResult = { ok: true; lut: Lut3D } | { ok: false; error: string };

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

/** Экран «Экспорт» (spec, «Экраны»); папку спрашивает main. */
export interface ExportRequest {
  /** Проект, из которого экспортируем: если открыт уже другой, экспорт не начнётся. */
  dir: string;
  lut?: LutExportRequest;
  /** Калибровочная карта `Калибровка.png` рядом с LUT (docs/decisions/0016-calibration-card.md). */
  card?: boolean;
  /** JPEG постов из оригиналов по кадру ленты, с номерами плана публикации (docs/decisions/0017-post-export.md, 0022). */
  posts?: boolean;
  /** `Сетка.png` из окон сетки. */
  grid?: boolean;
  /** `.cube` связки «поправка фото + образ» на каждый пост. */
  postLuts?: boolean;
}

/** «Проверить карту…»: карту, которую вернул редактор, main спрашивает диалогом и сверяет с образом. */
export interface CalibrationCheckRequest {
  dir: string;
  lookId: string;
}

/** Отчёт по карте или ошибка: образа нет, копия его LUT пропала, файл не читается. */
export type CalibrationCheckResult = { ok: true; file: string; lookName: string; report: CardReport } | { ok: false; error: string };

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
  /** Незаписанные файлы: пост без оригинала, ошибка диска. */
  errors: { file: string; message: string }[];
  /**
   * Записанные с оговоркой: оригинал увеличен, плитка сетки из превью. file '' — оговорка плана публикации без
   * файла: пустая позиция, пост ниже опубликованного (docs/decisions/0022-statuses-empty-pinned.md).
   */
  warnings: { file: string; message: string }[];
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
  /** Спросить возвращённую калибровочную карту и сверить её с образом. null — отменено или проект уже другой. */
  'calibration:check': { args: [request: CalibrationCheckRequest]; result: CalibrationCheckResult | null };
  /** Спросить `.cube` и импортировать его новым образом. null — нет проекта или отменено. */
  'lut:import': { args: []; result: LutImportResult | null };
  /** Разобранный LUT по id из реестра открытого проекта. */
  'lut:data': { args: [id: string]; result: LutDataResult };
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
  'calibration:check': true,
  'lut:import': true,
  'lut:data': true,
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

/** Оригинал фото для поста или плитки сетки: читается целиком и сверяется по хэшу (ADR 0017). */
export interface ExportSource {
  path: string;
  /** SHA-256 из AssetRef: изменившийся оригинал не экспортируется. */
  hash: string;
}

/** Пост: JPEG из оригинала по кадру ленты и/или `.cube` его связки «поправка фото + образ». */
export interface PostExportItem {
  /** «1 — рампа», «9 — рампа (закрепить)»: файлы <fileBase>.jpg и <fileBase>.cube. */
  fileBase: string;
  source: ExportSource;
  crop: Crop;
  /** Поправка фото, образ и LUT образа — то, что видно на плитке. */
  params: PipelineParams;
  jpeg: boolean;
  cube: boolean;
}

/** Плитка `Сетка.png`: окно сетки из оригинала, а если его нет — из прокси 2048. */
export interface GridTileItem {
  /** «плитка 3 (рампа)» — для оговорок в отчёте. */
  label: string;
  source: ExportSource;
  /** Прокси 2048 в cache/ проекта: запасной источник, если оригинал пропал или изменился. */
  fallback: string;
  crop: Crop;
  params: PipelineParams;
}

export interface GridExportItem {
  file: string;
  ratio: Ratio;
  columns: number;
  /** По порядку сетки; null — позиция без фото. */
  tiles: (GridTileItem | null)[];
}

/**
 * Экспорт в utility process: калибровочная карта, LUT образов, посты в порядке публикации, сетка.
 * Папка уже создана main; файлы в ней не перезаписываются.
 */
export interface ExportJob {
  type: 'export';
  jobId: string;
  dir: string;
  /** Имя файла карты или null, если карта не нужна. */
  cardFile: string | null;
  luts: LutExportItem[];
  posts: PostExportItem[];
  grid: GridExportItem | null;
}

/** Проверка возвращённой карты: чтение рецептом цвета прокси (ADR 0004), замер и диагноз core. */
export interface CardCheckJob {
  type: 'check-card';
  jobId: string;
  path: string;
  /** Проход образа: ожидание — то, что видно в Gridtone. */
  params: PipelineParams;
}

export type IndexerRequest = IndexJob | ExportJob | CardCheckJob;

export type IndexedAsset = Omit<AssetRef, 'importedAt'>;

export type IndexErrorCode = 'unsupported' | 'hash-mismatch' | 'failed';

export type IndexerResponse =
  | { type: 'item'; jobId: string; index: number; ok: true; asset: IndexedAsset }
  | { type: 'item'; jobId: string; index: number; ok: false; code: IndexErrorCode; error: string }
  /** Экспорт: файл записан (ok), возможно с оговорками, или не записан; file — имя внутри папки задачи. */
  | { type: 'file'; jobId: string; file: string; ok: true; warnings?: string[] }
  | { type: 'file'; jobId: string; file: string; ok: false; error: string }
  /** Проверка карты: последнее сообщение задачи, 'done' после него не приходит. */
  | { type: 'card'; jobId: string; ok: true; report: CardReport }
  | { type: 'card'; jobId: string; ok: false; error: string }
  | { type: 'done'; jobId: string };
