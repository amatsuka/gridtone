// Экспорт (spec, «Экраны» → «Экспорт»; docs/decisions/0014-lut-export.md, 0016-calibration-card.md).
// main проверяет запрос renderer, создаёт новую подпапку и отдаёт запекание и запись utility process;
// ход экспорта уходит в renderer событиями. Там же проверяется возвращённая калибровочная карта.
// Диалоги — в actions.ts, здесь Electron не нужен.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineParams } from '@core/color/bake';
import { lookPipeline } from '@core/lut/bake';
import type { CardReport } from '@core/lut/calibration';
import type { Lut3D } from '@core/lut/lut3d';
import { LUT_EXPORT_SIZES, type LutExportSize } from '@core/lut/verify';
import { CARD_FILE_BASE, exportFolderName, safeFileName, uniqueNames } from '@core/project/fileNames';
import { isRecord } from '@core/project/json';
import type { Look, Project } from '@core/project/types';
import type {
  CalibrationCheckRequest,
  CardCheckJob,
  ExportJob,
  ExportProgress,
  ExportRequest,
  ExportStarted,
  IndexerResponse,
  LutExportItem,
  LutExportRequest,
} from '@shared/ipc';

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
  const card = value['card'];
  if (card !== undefined) {
    if (typeof card !== 'boolean') throw new Error('Неверный раздел карты в запросе экспорта');
    request.card = card;
  }
  return request;
}

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

/** Что пишет задача экспорта: карта (имя файла или null) и LUT образов. */
export type ExportPlan = Pick<ExportJob, 'cardFile' | 'luts'>;

export interface ExportServiceOptions {
  luts?: LutSource;
  now?: () => Date;
}

export class ExportService {
  private readonly luts: LutSource;
  private readonly now: () => Date;

  constructor(
    private readonly port: ExportPort,
    private readonly onProgress: (progress: ExportProgress) => void,
    options: ExportServiceOptions = {},
  ) {
    this.luts = options.luts ?? NO_LUTS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Проверяет запрос до диалога и загружает LUT выбранных образов: ошибка не должна приходить после
   * выбора папки. Если копия LUT пропала, экспорт этого образа обманул бы — бросает с причиной.
   */
  async plan(project: Project, request: ExportRequest): Promise<ExportPlan> {
    if (!request.lut && !request.card) throw new Error('Нечего экспортировать');
    const cardFile = request.card ? `${CARD_FILE_BASE}.png` : null;
    if (!request.lut) return { cardFile, luts: [] };
    const luts = new Map<string, Lut3D>();
    for (const { id } of request.lut.looks) {
      const lutId = project.looks.find((look) => look.id === id)?.importedLut;
      if (lutId !== undefined && !luts.has(lutId)) luts.set(lutId, await this.luts.loadLut(lutId));
    }
    return { cardFile, luts: lutExportItems(project, request.lut, luts, cardFile === null ? [] : [CARD_FILE_BASE]) };
  }

  /** Создаёт подпапку в root и запускает экспорт. Ход и итог — в onProgress. */
  async start(root: string, project: Project, request: ExportRequest): Promise<ExportStarted> {
    const plan = await this.plan(project, request);
    const dir = await createExportFolder(root, exportFolderName(project.name, this.now()));
    const jobId = randomUUID();
    const progress: ExportProgress = {
      jobId,
      dir,
      total: Number(plan.cardFile !== null) + plan.luts.reduce((n, item) => n + Number(item.cube) + Number(item.hald), 0),
      done: 0,
      files: [],
      errors: [],
      finished: false,
    };
    const report = () => this.onProgress({ ...progress, files: [...progress.files], errors: [...progress.errors] });
    report();
    this.port.runExport({ jobId, dir, ...plan }, (message) => {
      if (message.type === 'file') {
        if (message.ok) progress.files.push(message.file);
        else progress.errors.push({ file: message.file, message: message.error });
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
