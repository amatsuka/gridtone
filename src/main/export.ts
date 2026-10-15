// Экспорт (spec, «Экраны» → «Экспорт»; docs/decisions/0014-lut-export.md, 0016-calibration-card.md,
// 0017-post-export.md, 0026-content-plan.md). main проверяет запрос renderer, создаёт новую подпапку и отдаёт
// запекание и запись utility process; ход экспорта уходит в renderer событиями. Там же проверяется возвращённая
// калибровочная карта. Диалоги — в actions.ts, здесь Electron не нужен.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineParams } from '@core/color/bake';
import { lookPipeline, postPipeline } from '@core/lut/bake';
import type { CardReport } from '@core/lut/calibration';
import type { Lut3D } from '@core/lut/lut3d';
import { LUT_EXPORT_SIZES, type LutExportSize } from '@core/lut/verify';
import { contentPlan, planCsv, planMarkdown } from '@core/pattern/plan';
import { targetGridColors } from '@core/pattern/targetGrid';
import {
  CARD_FILE_BASE,
  GRID_FILE_BASE,
  PLAN_FILE_BASE,
  TARGETS_FILE_BASE,
  exportFolderName,
  fileStem,
  safeFileName,
  uniqueNames,
} from '@core/project/fileNames';
import { isRecord } from '@core/project/json';
import { planNotes, planOrder, postFileBases } from '@core/project/publish';
import type { AssetRef, Look, Project, Slot } from '@core/project/types';
import type {
  CalibrationCheckRequest,
  CardCheckJob,
  ExportJob,
  ExportProgress,
  ExportRequest,
  ExportStarted,
  GridExportItem,
  IndexerResponse,
  LutExportItem,
  LutExportRequest,
  PlanExportItem,
  PlanExportRequest,
  PostExportItem,
} from '@shared/ipc';
import { proxyFile } from './project/paths';

/** utility process: запись файлов экспорта и проверка карты. */
export interface ExportPort {
  runExport(job: Omit<ExportJob, 'type'>, onMessage: (message: IndexerResponse) => void): void;
  checkCard(job: Omit<CardCheckJob, 'type'>): Promise<CardReport>;
}

/** Импортированные LUT образов (ADR 0015): разобранный LUT по id реестра или ошибка, если копия пропала. */
export interface LutSource {
  loadLut(id: string): Promise<Lut3D>;
}

const NO_LUTS: LutSource = {
  loadLut: () => Promise.reject(new Error('LUT недоступен')),
};

/** Имя файла, если от имени образа ничего не осталось. */
const LOOK_FALLBACK = 'Образ';

/** Запрос из renderer — недоверенные данные: форма проверяется целиком. */
export function parseExportRequest(value: unknown): ExportRequest {
  if (!isRecord(value) || typeof value['dir'] !== 'string') throw new Error('Неверный запрос экспорта');
  const request: ExportRequest = { dir: value['dir'] };
  const lut = value['lut'];
  if (lut !== undefined) {
    if (!isRecord(lut) || !Array.isArray(lut['looks']) || typeof lut['cube'] !== 'boolean' || typeof lut['hald'] !== 'boolean') {
      throw new Error('Неверный раздел LUT в запросе экспорта');
    }
    const looks = lut['looks'].map((item: unknown) => {
      if (!isRecord(item) || typeof item['id'] !== 'string' || !LUT_EXPORT_SIZES.includes(item['size'] as LutExportSize)) {
        throw new Error('Неверный образ в запросе экспорта');
      }
      return { id: item['id'], size: item['size'] as LutExportSize };
    });
    request.lut = { looks, cube: lut['cube'], hald: lut['hald'] };
  }
  for (const key of ['card', 'posts', 'grid', 'postLuts'] as const) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') throw new Error(`Неверный раздел ${SECTION_NAMES[key]} в запросе экспорта`);
    request[key] = flag;
  }
  const plan = value['plan'];
  if (plan !== undefined) {
    if (!isRecord(plan) || PLAN_FORMATS.some((key) => typeof plan[key] !== 'boolean')) {
      throw new Error('Неверный раздел плана в запросе экспорта');
    }
    request.plan = { markdown: plan['markdown'] as boolean, csv: plan['csv'] as boolean, image: plan['image'] as boolean };
  }
  return request;
}

const PLAN_FORMATS = ['markdown', 'csv', 'image'] as const;

const SECTION_NAMES = { card: 'карты', posts: 'постов', grid: 'сетки', postLuts: 'LUT постов' } as const;

export function parseCalibrationRequest(value: unknown): CalibrationCheckRequest {
  if (!isRecord(value) || typeof value['dir'] !== 'string' || typeof value['lookId'] !== 'string') {
    throw new Error('Неверный запрос проверки карты');
  }
  return { dir: value['dir'], lookId: value['lookId'] };
}

/**
 * Задачи запекания по образам проекта. Бросает, если выбрать нечего или образа уже нет.
 * luts — импортированные LUT выбранных образов: LUT образа запекается вместе с его шагом 9.
 * reserved — имена файлов без расширения, уже занятые в подпапке (карта): образ с таким именем получит номер.
 */
export function lutExportItems(
  project: Project,
  request: LutExportRequest,
  luts: ReadonlyMap<string, Lut3D> = new Map(),
  reserved: readonly string[] = [],
): LutExportItem[] {
  if (!request.cube && !request.hald) throw new Error('Не выбран ни один формат LUT');
  if (request.looks.length === 0) throw new Error('Не выбран ни один образ');
  if (new Set(request.looks.map((look) => look.id)).size !== request.looks.length) throw new Error('Образ выбран дважды');
  const looks = request.looks.map(({ id }) => {
    const look = project.looks.find((l) => l.id === id);
    if (!look) throw new Error('Образ уже удалён из проекта');
    return look;
  });
  const names = uniqueNames([...reserved, ...looks.map((look) => safeFileName(look.name, LOOK_FALLBACK))]).slice(reserved.length);
  return looks.map((look, i) => {
    const lut = look.importedLut === undefined ? undefined : luts.get(look.importedLut);
    if (look.importedLut !== undefined && !lut) throw new Error(`LUT образа «${look.name}» не загружен`);
    return {
      fileBase: names[i] as string,
      title: look.name,
      params: lookPipeline(look.adjust, lut),
      size: (request.looks[i] as { size: LutExportSize }).size,
      cube: request.cube,
      hald: request.hald,
    };
  });
}

/**
 * Параметры плитки — то, что видно в сетке: поправка фото, образ и LUT образа (шаг 9).
 * luts — загруженные LUT образов; если копии нет, экспорт обманул бы — бросает.
 */
function slotPipeline(slot: Slot, looks: ReadonlyMap<string, Look>, luts: ReadonlyMap<string, Lut3D>): PipelineParams {
  const look = slot.lookId === undefined ? undefined : looks.get(slot.lookId);
  const lut = look?.importedLut === undefined ? undefined : luts.get(look.importedLut);
  if (look?.importedLut !== undefined && !lut) throw new Error(`LUT образа «${look.name}» не загружен`);
  return postPipeline(slot.adjust, look?.adjust, lut);
}

function assetOf(project: Project, slot: Slot): AssetRef | undefined {
  return slot.assetId === undefined ? undefined : project.assets[slot.assetId];
}

/**
 * Посты в порядке публикации (docs/decisions/0017-post-export.md, 0022-statuses-empty-pinned.md): номер файла —
 * номер в плане (planOrder), последняя плитка сетки — «1 — …»; у пустых позиций номера пропущены, закреплённые —
 * последними, с «(закрепить)». jpeg — JPEG из оригинала, cube — LUT связки «поправка фото + образ». reserved —
 * имена файлов без расширения, уже занятые в подпапке. Бросает, если публиковать нечего.
 */
export function postExportItems(
  project: Project,
  formats: { jpeg: boolean; cube: boolean },
  luts: ReadonlyMap<string, Lut3D> = new Map(),
  reserved: readonly string[] = [],
): PostExportItem[] {
  const plan = planOrder(project.slots, project.grid.pinned);
  const entries = plan.filter((entry) => entry.photo);
  if (entries.length === 0) throw new Error('В сетке нет постов к публикации');
  const looks = new Map(project.looks.map((look) => [look.id, look]));
  const slots = entries.map((entry) => project.slots[entry.index] as Slot);
  const assets = slots.map((slot) => {
    const asset = assetOf(project, slot);
    if (!asset) throw new Error('У поста нет фото в проекте');
    return asset;
  });
  const bases = postFileBases(
    entries.map((entry, k) => ({ number: entry.number, stem: fileStem((assets[k] as AssetRef).path), pin: entry.pin })),
    plan.length,
    reserved,
  );
  return slots.map((slot, k) => {
    const asset = assets[k] as AssetRef;
    return {
      fileBase: bases[k] as string,
      source: { path: asset.path, hash: asset.hash },
      crop: slot.crop,
      params: slotPipeline(slot, looks, luts),
      jpeg: formats.jpeg,
      cube: formats.cube,
    };
  });
}

/**
 * `Сетка.png`: все позиции сетки по порядку, опубликованные тоже — они часть профиля. Позиция без
 * фото — null. fallback — прокси 2048 ассета: им плитка заменяется, если оригинал пропал.
 */
export function gridExportItem(
  project: Project,
  fallback: (assetId: string) => string,
  luts: ReadonlyMap<string, Lut3D> = new Map(),
): GridExportItem {
  if (project.slots.length === 0) throw new Error('В сетке нет плиток');
  const looks = new Map(project.looks.map((look) => [look.id, look]));
  return {
    file: `${GRID_FILE_BASE}.png`,
    ratio: project.grid.ratio,
    columns: project.grid.columns,
    tiles: project.slots.map((slot, i) => {
      const asset = assetOf(project, slot);
      if (!asset) return null;
      return {
        label: `плитка ${i + 1} (${fileStem(asset.path)})`,
        source: { path: asset.path, hash: asset.hash },
        fallback: fallback(asset.id),
        crop: slot.crop,
        params: slotPipeline(slot, looks, luts),
      };
    }),
  };
}

/**
 * План контента (docs/decisions/0026-content-plan.md): `План.md` и `План.csv` — тексты core по плану проекта
 * (contentPlan), `Цели.png` — цвета целей позиций, пиксели посчитает core в utility process. Бросает до диалога,
 * если формат не выбран, в плане нет позиций или у позиций нет целей.
 */
export function planExportItem(project: Project, request: PlanExportRequest): PlanExportItem {
  if (!request.markdown && !request.csv && !request.image) throw new Error('Не выбран ни один формат плана');
  const plan = contentPlan(project);
  if ((request.markdown || request.csv) && plan.cards.length === 0) {
    throw new Error('В плане нет позиций: в сетке нет запланированных постов и пустых позиций');
  }
  const texts: PlanExportItem['texts'] = [];
  if (request.markdown) texts.push({ file: `${PLAN_FILE_BASE}.md`, text: planMarkdown(plan, project.name) });
  if (request.csv) texts.push({ file: `${PLAN_FILE_BASE}.csv`, text: planCsv(plan) });
  let image: PlanExportItem['image'] = null;
  if (request.image) {
    if (project.slots.length === 0) throw new Error('В сетке нет плиток');
    const colors = targetGridColors(project);
    if (colors.every((color) => color === null)) throw new Error('У позиций нет целей: примените паттерн к сетке');
    image = { file: `${TARGETS_FILE_BASE}.png`, ratio: project.grid.ratio, columns: project.grid.columns, colors };
  }
  return { texts, image };
}

/** Новая папка name в root; если такая есть — «name (2)» и далее. Существующие папки не трогаются. */
export async function createExportFolder(root: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = join(root, n === 1 ? name : `${name} (${n})`);
    try {
      await mkdir(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * Что пишет задача экспорта: карта (имя файла или null), LUT образов, посты и сетка. notes — оговорки плана
 * публикации (пустые позиции, пост ниже опубликованного): они идут в отчёт сразу, без файла.
 */
export type ExportPlan = Pick<ExportJob, 'cardFile' | 'luts' | 'posts' | 'grid' | 'plan'> & { notes: string[] };

export interface ExportServiceOptions {
  luts?: LutSource;
  now?: () => Date;
}

/** Файлов в задаче: столько сообщений 'file' придёт из utility process. */
export function exportFileCount({ cardFile, luts, posts, grid, plan }: Omit<ExportPlan, 'notes'>): number {
  const lutFiles = luts.reduce((n, item) => n + Number(item.cube) + Number(item.hald), 0);
  const postFiles = posts.reduce((n, item) => n + Number(item.jpeg) + Number(item.cube), 0);
  const planFiles = plan ? plan.texts.length + Number(plan.image !== null) : 0;
  return Number(cardFile !== null) + lutFiles + postFiles + Number(grid !== null) + planFiles;
}

export class ExportService {
  private readonly luts: LutSource;
  private readonly now: () => Date;
  /** Подпапки, созданные экспортом в этом запуске: только их renderer может показать в Finder. */
  private readonly folders = new Set<string>();

  constructor(
    private readonly port: ExportPort,
    private readonly onProgress: (progress: ExportProgress) => void,
    options: ExportServiceOptions = {},
  ) {
    this.luts = options.luts ?? NO_LUTS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Проверяет запрос до диалога и загружает LUT нужных образов — выбранных в разделе LUT и назначенных
   * плиткам для постов и сетки: ошибка не должна приходить после выбора папки. Если копия LUT пропала,
   * экспорт обманул бы — бросает с причиной. Пропавший оригинал проверяет utility process: пост
   * пропускается, остальные пишутся.
   */
  async plan(project: Project, request: ExportRequest): Promise<ExportPlan> {
    const posts = request.posts === true || request.postLuts === true;
    if (!request.lut && !request.card && !posts && !request.grid && !request.plan) throw new Error('Нечего экспортировать');
    const cardFile = request.card ? `${CARD_FILE_BASE}.png` : null;
    // План проверяется первым: его ошибки не зависят от LUT.
    const plan = request.plan ? planExportItem(project, request.plan) : null;
    // Имена из одной подпапки не сталкиваются: карта, сетка и план, затем образы, затем посты.
    const reserved = [
      ...(cardFile === null ? [] : [CARD_FILE_BASE]),
      ...(request.grid ? [GRID_FILE_BASE] : []),
      ...(plan && plan.texts.length > 0 ? [PLAN_FILE_BASE] : []),
      ...(plan?.image ? [TARGETS_FILE_BASE] : []),
    ];
    const lookIds = new Set(request.lut?.looks.map(({ id }) => id));
    if (posts || request.grid) for (const slot of project.slots) if (slot.assetId !== undefined && slot.lookId) lookIds.add(slot.lookId);
    const luts = new Map<string, Lut3D>();
    for (const id of lookIds) {
      const lutId = project.looks.find((look) => look.id === id)?.importedLut;
      if (lutId !== undefined && !luts.has(lutId)) luts.set(lutId, await this.luts.loadLut(lutId));
    }
    const lutItems = request.lut ? lutExportItems(project, request.lut, luts, reserved) : [];
    return {
      notes: posts ? planNotes(planOrder(project.slots, project.grid.pinned)) : [],
      cardFile,
      luts: lutItems,
      posts: posts
        ? postExportItems(project, { jpeg: request.posts === true, cube: request.postLuts === true }, luts, [
            ...reserved,
            ...lutItems.map((item) => item.fileBase),
          ])
        : [],
      grid: request.grid ? gridExportItem(project, (assetId) => proxyFile(request.dir, assetId, 2048), luts) : null,
      plan,
    };
  }

  /** Создаёт подпапку в root и запускает экспорт. Ход и итог — в onProgress. */
  async start(root: string, project: Project, request: ExportRequest): Promise<ExportStarted> {
    const { notes, ...plan } = await this.plan(project, request);
    const dir = await createExportFolder(root, exportFolderName(project.name, this.now()));
    this.folders.add(dir);
    const jobId = randomUUID();
    const progress: ExportProgress = {
      jobId,
      dir,
      total: exportFileCount(plan),
      done: 0,
      files: [],
      errors: [],
      // Оговорки плана — без файла, первыми в отчёте.
      warnings: notes.map((message) => ({ file: '', message })),
      finished: false,
    };
    const report = () =>
      this.onProgress({ ...progress, files: [...progress.files], errors: [...progress.errors], warnings: [...progress.warnings] });
    report();
    this.port.runExport({ jobId, dir, ...plan }, (message) => {
      if (message.type === 'file') {
        if (message.ok) {
          progress.files.push(message.file);
          for (const warning of message.warnings ?? []) progress.warnings.push({ file: message.file, message: warning });
        } else {
          progress.errors.push({ file: message.file, message: message.error });
        }
        if (message.file !== '') progress.done++;
      } else if (message.type === 'done') {
        progress.finished = true;
      } else {
        return;
      }
      report();
    });
    return { jobId, dir };
  }

  /** Папку создал экспорт в этом запуске: путь из renderer — ровно тот, что вернул start. */
  isExportFolder(dir: string): boolean {
    return this.folders.has(dir);
  }

  /**
   * Ожидание для проверки карты — проход образа с его импортированным LUT: то, что видно в Gridtone.
   * Бросает до диалога выбора файла, если образа уже нет или копия его LUT пропала.
   */
  async cardParams(project: Project, lookId: string): Promise<{ look: Look; params: PipelineParams }> {
    const look = project.looks.find((l) => l.id === lookId);
    if (!look) throw new Error('Образ уже удалён из проекта');
    const lut = look.importedLut === undefined ? undefined : await this.luts.loadLut(look.importedLut);
    return { look, params: lookPipeline(look.adjust, lut) };
  }

  /** Возвращённая карта → отчёт: чтение, замер и диагноз — в utility process. */
  checkCard(path: string, params: PipelineParams): Promise<CardReport> {
    return this.port.checkCard({ jobId: randomUUID(), path, params });
  }
}
