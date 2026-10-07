import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { createProject, createSlot } from '@core/project/defaults';
import { applyProjectPatches } from '@core/project/patch';
import type { AssetRef, Project } from '@core/project/types';
import { ASSET_ID_RE, PROXY_SIZES, type ProxySize } from '@shared/cache';
import type {
  AssetStatus,
  ImportProgress,
  IndexJob,
  IndexerResponse,
  PatchBatch,
  ProjectSnapshot,
  ProjectStatus,
} from '@shared/ipc';
import { createProjectFolder, exists, readProjectFile, writeProjectFile } from './fs';
import { cacheDir, proxyFile } from './paths';
import { ProjectSession } from './session';

export const IMPORT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'];
const AUTOSAVE_DELAY_MS = 500;

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
    return this.start(dir, project, {});
  }

  async open(dir: string): Promise<ProjectSnapshot> {
    // Сначала читаем: если файл битый, текущий проект остаётся открытым.
    const project = await readProjectFile(dir);
    await this.close();
    const { status, stale } = await inspectAssets(dir, project);
    const snapshot = this.start(dir, project, status);
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
    this.events.snapshot(null);
  }

  /** Закрыть без сохранения — только по явному выбору пользователя после ошибки записи. */
  discard(): void {
    this.session?.dispose();
    this.session = null;
    this.events.snapshot(null);
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
          project.slots.push(createSlot(randomUUID(), asset.id));
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

  private start(dir: string, project: Project, assets: Record<string, AssetStatus>): ProjectSnapshot {
    const session: ProjectSession = new ProjectSession(dir, project, assets, {
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
