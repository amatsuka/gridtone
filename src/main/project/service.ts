import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { CubeError, parseCube } from '@core/lut/cube';
import type { Lut3D } from '@core/lut/lut3d';
import { positionTarget } from '@core/pattern/pattern';
import { createProject, createSlot } from '@core/project/defaults';
import { addImportedLut, lookNameForLut, LUT_ID_RE, lutIdFromHash } from '@core/project/luts';
import { applyProjectPatches } from '@core/project/patch';
import type { AssetRef, LutRef, Project } from '@core/project/types';
import { ASSET_ID_RE, PROXY_SIZES, type ProxySize } from '@shared/cache';
import type {
  AssetStatus,
  ImportProgress,
  IndexJob,
  IndexerResponse,
  LutDataResult,
  LutFileStatus,
  LutImportResult,
  PatchBatch,
  ProjectSnapshot,
  ProjectStatus,
} from '@shared/ipc';
import { createProjectFolder, exists, readProjectFile, writeProjectFile } from './fs';
import { cacheDir, lutFile, lutsDir, proxyFile } from './paths';
import { ProjectSession } from './session';

export const IMPORT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'];
const AUTOSAVE_DELAY_MS = 500;
/** `.cube` 65³ с 6 знаками — около 9 МБ; больше этого предела файл не читается. */
export const LUT_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** Разобранных LUT в памяти main: 65³ во Float64 — 6.6 МБ. */
const LUT_CACHE_MAX = 4;

export interface IndexerPort {
  run(job: Omit<IndexJob, 'type'>, onMessage: (message: IndexerResponse) => void): void;
}

export interface ServiceEvents {
  snapshot(snapshot: ProjectSnapshot | null): void;
  status(status: ProjectStatus): void;
  importProgress(progress: ImportProgress): void;
}

export interface ServiceOptions {
  autosaveDelayMs?: number;
  write?: (dir: string, project: Project) => Promise<void>;
}

type ItemResult = Extract<IndexerResponse, { type: 'item' }>;

/** Открытый проект, импорт и сверка кэша. Без Electron: диалоги и окна живут в actions.ts. */
export class ProjectService {
  private session: ProjectSession | null = null;
  /** Разобранные LUT открытого проекта по id; id выводится из содержимого, поэтому кэш не устаревает. */
  private readonly lutCache = new Map<string, Lut3D>();

  constructor(
    private readonly indexer: IndexerPort,
    private readonly events: ServiceEvents,
    private readonly options: ServiceOptions = {},
  ) {}

  get hasProject(): boolean {
    return this.session !== null;
  }

  snapshot(): ProjectSnapshot | null {
    return this.session?.snapshot() ?? null;
  }

  async create(dir: string): Promise<ProjectSnapshot> {
    const project = createProject(basename(dir));
    await createProjectFolder(dir, project);
    await this.close();
    return this.start(dir, project, {}, {});
  }

  async open(dir: string): Promise<ProjectSnapshot> {
    // Сначала читаем: если файл битый, текущий проект остаётся открытым.
    const project = await readProjectFile(dir);
    await this.close();
    const [{ status, stale }, luts] = await Promise.all([inspectAssets(dir, project), inspectLuts(dir, project)]);
    const snapshot = this.start(dir, project, status, luts);
    if (stale.length > 0) this.rebuildProxies(stale);
    return snapshot;
  }

  async save(): Promise<void> {
    await this.session?.flush();
  }

  /** Сохраняет и закрывает проект. Если сохранить не удалось — бросает, проект остаётся открытым. */
  async close(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.close();
    this.session = null;
    this.lutCache.clear();
    this.events.snapshot(null);
  }

  /** Закрыть без сохранения — только по явному выбору пользователя после ошибки записи. */
  discard(): void {
    this.session?.dispose();
    this.session = null;
    this.lutCache.clear();
    this.events.snapshot(null);
  }

  /**
   * Импорт `.cube` (docs/decisions/0015-lut-import.md): разбор core, копия в luts/<id>.cube, запись
   * реестра, если её нет, и новый образ в конце looks. Если файл не годится, проект не меняется.
   */
  async importLut(path: string): Promise<LutImportResult> {
    const session = this.session;
    if (!session) return { ok: false, error: 'Проект не открыт' };
    const file = basename(path);
    let bytes: Buffer;
    let lut: Lut3D;
    try {
      if ((await stat(path)).size > LUT_FILE_MAX_BYTES) {
        return { ok: false, error: `${file}: файл больше ${LUT_FILE_MAX_BYTES / 1024 / 1024} МБ — это не LUT до 65³` };
      }
      bytes = await readFile(path);
      lut = parseCube(bytes.toString('utf8'));
    } catch (err) {
      const reason = err instanceof CubeError ? err.message : `не удалось прочитать файл (${err instanceof Error ? err.message : String(err)})`;
      return { ok: false, error: `${file}: ${reason}` };
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = lutIdFromHash(hash);
    try {
      await writeLutCopy(session.dir, id, hash, bytes);
    } catch (err) {
      return { ok: false, error: `${file}: не удалось скопировать в папку проекта (${err instanceof Error ? err.message : String(err)})` };
    }
    // Пока читали файл, проект могли закрыть или сменить.
    if (this.session !== session) return { ok: false, error: 'Проект закрыт во время импорта' };
    this.cacheLut(id, lut);
    const ref: LutRef = { id, name: file, size: lut.size, hash, importedAt: new Date().toISOString() };
    const lookId = randomUUID();
    session.update((project, _assets, luts) => {
      addImportedLut(project, ref, lookId, lookNameForLut(lut.title, file));
      luts[id] = 'ok';
    });
    return { ok: true, lookId };
  }

  /** Разобранный LUT из реестра открытого проекта. Бросает, если копии нет или она изменилась. */
  async loadLut(id: string): Promise<Lut3D> {
    const session = this.session;
    const ref = session && LUT_ID_RE.test(id) ? session.project.luts[id] : undefined;
    if (!session || !ref) throw new Error('LUT нет в проекте');
    const cached = this.lutCache.get(id);
    if (cached) {
      this.cacheLut(id, cached);
      return cached;
    }
    try {
      const bytes = await readFile(lutFile(session.dir, id));
      if (createHash('sha256').update(bytes).digest('hex') !== ref.hash) throw new Error('копия LUT изменилась после импорта');
      const lut = parseCube(bytes.toString('utf8'));
      if (this.session === session) this.cacheLut(id, lut);
      return lut;
    } catch (err) {
      if (this.session === session) session.setLutStatus(id, 'missing');
      const reason = isMissing(err) ? 'файла нет в папке luts/ проекта' : err instanceof Error ? err.message : String(err);
      throw new Error(`LUT «${ref.name}»: ${reason}. Импортируйте этот файл ещё раз.`);
    }
  }

  /** Для IPC: ошибка — значение, а не исключение. */
  async lutData(id: unknown): Promise<LutDataResult> {
    try {
      return { ok: true, lut: await this.loadLut(typeof id === 'string' ? id : '') };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Правки из renderer. Бросает, если проект уже другой или патч запрещён; тогда проект не меняется. */
  applyPatches(batch: PatchBatch): void {
    const session = this.session;
    if (!session || session.dir !== batch.dir) throw new Error('Проект, к которому относится правка, уже закрыт');
    session.update((project) => applyProjectPatches(project, batch.patches), { patchSeq: batch.seq });
  }

  /** Файл прокси для протокола gridtone://. Отдаём только ассеты открытого проекта. */
  proxyPath(assetId: string, size: ProxySize): string | null {
    const session = this.session;
    if (!session || !ASSET_ID_RE.test(assetId) || !session.project.assets[assetId]) return null;
    return proxyFile(session.dir, assetId, size);
  }

  /** Запускает импорт и сразу возвращает id задачи; ход импорта приходит в events.importProgress. */
  importFiles(paths: readonly string[]): string | null {
    const session = this.session;
    if (!session) return null;

    const jobId = randomUUID();
    const progress: ImportProgress = {
      jobId,
      total: paths.length,
      done: 0,
      added: 0,
      duplicates: 0,
      errors: [],
      finished: false,
    };
    const report = () => this.events.importProgress({ ...progress, errors: [...progress.errors] });

    const files: string[] = [];
    for (const path of paths) {
      if (isImportable(path)) {
        files.push(path);
      } else {
        const heic = /\.(heic|heif)$/i.test(path);
        progress.errors.push({ path, message: heic ? 'HEIC пока не поддерживается' : 'Формат не поддерживается' });
        progress.done++;
      }
    }
    files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

    if (files.length === 0) {
      progress.finished = true;
      report();
      return jobId;
    }
    report();

    // Индексатор отвечает в любом порядке, а в сетку фото попадают строго в порядке файлов.
    const results: (ItemResult | undefined)[] = [];
    let next = 0;
    const commit = () => {
      const added: AssetRef[] = [];
      const relinked: { id: string; path: string }[] = [];
      const known = new Set(Object.keys(session.project.assets));
      for (let result = results[next]; result !== undefined; result = results[++next]) {
        if (!result.ok) {
          progress.errors.push({ path: files[result.index] ?? '', message: result.error });
          continue;
        }
        const { asset } = result;
        if (known.has(asset.id)) {
          progress.duplicates++;
          // Тот же файл нашёлся на новом месте — восстанавливаем ссылку на пропавший оригинал.
          if (session.assets[asset.id]?.original !== 'ok') relinked.push({ id: asset.id, path: asset.path });
          continue;
        }
        known.add(asset.id);
        added.push({ ...asset, importedAt: new Date().toISOString() });
      }
      if (added.length === 0 && relinked.length === 0) return;
      progress.added += added.length;
      session.update((project, assets) => {
        for (const asset of added) {
          project.assets[asset.id] = asset;
          // Слот — только в конец (ADR 0011); его цель — клетка паттерна для этой позиции (ADR 0023).
          const slot = createSlot(randomUUID(), asset.id);
          const target = positionTarget(project, project.slots.length);
          project.slots.push(target ? { ...slot, target } : slot);
          assets[asset.id] = { proxy: 'ready', original: 'ok' };
        }
        for (const { id, path } of relinked) {
          const asset = project.assets[id];
          if (asset) asset.path = path;
          assets[id] = { proxy: 'ready', original: 'ok' };
        }
      });
    };

    this.indexer.run({ jobId, cacheDir: cacheDir(session.dir), items: files.map((path) => ({ path })) }, (message) => {
      // Проект закрыли во время импорта: готовые прокси останутся в его cache/, в сетку ничего не добавляем.
      if (this.session !== session) return;
      if (message.type === 'item') {
        results[message.index] = message;
        progress.done++;
        commit();
      } else {
        progress.finished = true;
      }
      report();
    });
    return jobId;
  }

  private cacheLut(id: string, lut: Lut3D): void {
    this.lutCache.delete(id);
    this.lutCache.set(id, lut);
    for (const old of this.lutCache.keys()) {
      if (this.lutCache.size <= LUT_CACHE_MAX) break;
      this.lutCache.delete(old);
    }
  }

  private start(
    dir: string,
    project: Project,
    assets: Record<string, AssetStatus>,
    luts: Record<string, LutFileStatus>,
  ): ProjectSnapshot {
    this.lutCache.clear();
    const session: ProjectSession = new ProjectSession(dir, project, assets, luts, {
      write: this.options.write ?? writeProjectFile,
      autosaveDelayMs: this.options.autosaveDelayMs ?? AUTOSAVE_DELAY_MS,
      onChange: (kind) => {
        if (this.session !== session) return;
        if (kind === 'project') this.events.snapshot(session.snapshot());
        else this.events.status(session.status());
      },
    });
    this.session = session;
    const snapshot = session.snapshot();
    this.events.snapshot(snapshot);
    return snapshot;
  }

  /** Пересобирает пропавшие прокси из оригиналов, если их содержимое не изменилось. */
  private rebuildProxies(stale: AssetRef[]): void {
    const session = this.session;
    if (!session) return;
    const items = stale.map((asset) => ({ path: asset.path, expectHash: asset.hash }));
    this.indexer.run({ jobId: randomUUID(), cacheDir: cacheDir(session.dir), items }, (message) => {
      if (this.session !== session || message.type !== 'item') return;
      const asset = stale[message.index];
      if (!asset) return;
      if (message.ok) {
        session.setAssetStatus(asset.id, { proxy: 'ready' });
      } else {
        session.setAssetStatus(asset.id, {
          proxy: 'failed',
          ...(message.code === 'hash-mismatch' ? { original: 'changed' as const } : {}),
        });
      }
    });
  }
}

export function isImportable(path: string): boolean {
  return IMPORT_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

/**
 * Копия LUT в luts/<id>.cube. Существующая с тем же хэшем не трогается; повреждённая заменяется
 * атомарно — это наша копия, а не оригинал пользователя.
 */
async function writeLutCopy(dir: string, id: string, hash: string, bytes: Buffer): Promise<void> {
  const target = lutFile(dir, id);
  await mkdir(lutsDir(dir), { recursive: true });
  try {
    await writeFile(target, bytes, { flag: 'wx' });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const existing = await readFile(target);
  if (createHash('sha256').update(existing).digest('hex') === hash) return;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Статусы копий LUT при открытии: на месте ли файлы реестра. Хэш сверяется при чтении (loadLut). */
async function inspectLuts(dir: string, project: Project): Promise<Record<string, LutFileStatus>> {
  const status: Record<string, LutFileStatus> = {};
  await Promise.all(
    Object.keys(project.luts).map(async (id) => {
      status[id] = (await exists(lutFile(dir, id))) ? 'ok' : 'missing';
    }),
  );
  return status;
}

/** Статусы ассетов при открытии: есть ли прокси в cache/ и на месте ли оригиналы. */
async function inspectAssets(
  dir: string,
  project: Project,
): Promise<{ status: Record<string, AssetStatus>; stale: AssetRef[] }> {
  const status: Record<string, AssetStatus> = {};
  const stale: AssetRef[] = [];
  await Promise.all(
    Object.values(project.assets).map(async (asset) => {
      const [proxies, originalFound] = await Promise.all([
        Promise.all(PROXY_SIZES.map((size) => exists(proxyFile(dir, asset.id, size)))),
        exists(asset.path),
      ]);
      const proxiesReady = proxies.every(Boolean);
      status[asset.id] = {
        proxy: proxiesReady ? 'ready' : originalFound ? 'pending' : 'failed',
        original: originalFound ? 'ok' : 'missing',
      };
      if (!proxiesReady && originalFound) stale.push(asset);
    }),
  );
  return { status, stale };
}
