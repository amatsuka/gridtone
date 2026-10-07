// Экспорт (spec, «Экраны» → «Экспорт»; docs/decisions/0014-lut-export.md). main проверяет запрос renderer,
// создаёт новую подпапку и отдаёт запекание utility process; ход экспорта уходит в renderer событиями.
// Диалог выбора папки — в actions.ts, здесь Electron не нужен.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lookPipeline } from '@core/lut/bake';
import { LUT_EXPORT_SIZES, type LutExportSize } from '@core/lut/verify';
import { exportFolderName, safeFileName, uniqueNames } from '@core/project/fileNames';
import { isRecord } from '@core/project/json';
import type { Project } from '@core/project/types';
import type {
  ExportProgress,
  ExportRequest,
  ExportStarted,
  IndexerResponse,
  LutExportItem,
  LutExportJob,
  LutExportRequest,
} from '@shared/ipc';

export interface LutExportPort {
  exportLuts(job: Omit<LutExportJob, 'type'>, onMessage: (message: IndexerResponse) => void): void;
}

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
  return request;
}

/** Задачи запекания по образам проекта. Бросает, если выбрать нечего или образа уже нет. */
export function lutExportItems(project: Project, request: LutExportRequest): LutExportItem[] {
  if (!request.cube && !request.hald) throw new Error('Не выбран ни один формат LUT');
  if (request.looks.length === 0) throw new Error('Не выбран ни один образ');
  if (new Set(request.looks.map((look) => look.id)).size !== request.looks.length) throw new Error('Образ выбран дважды');
  const looks = request.looks.map(({ id }) => {
    const look = project.looks.find((l) => l.id === id);
    if (!look) throw new Error('Образ уже удалён из проекта');
    return look;
  });
  const names = uniqueNames(looks.map((look) => safeFileName(look.name, LOOK_FALLBACK)));
  return looks.map((look, i) => ({
    fileBase: names[i] as string,
    title: look.name,
    params: lookPipeline(look.adjust),
    size: (request.looks[i] as { size: LutExportSize }).size,
    cube: request.cube,
    hald: request.hald,
  }));
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

export class ExportService {
  constructor(
    private readonly port: LutExportPort,
    private readonly onProgress: (progress: ExportProgress) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Проверяет запрос до диалога: ошибка не должна приходить после выбора папки. */
  plan(project: Project, request: ExportRequest): LutExportItem[] {
    if (!request.lut) throw new Error('Нечего экспортировать');
    return lutExportItems(project, request.lut);
  }

  /** Создаёт подпапку в root и запускает экспорт. Ход и итог — в onProgress. */
  async start(root: string, project: Project, request: ExportRequest): Promise<ExportStarted> {
    const items = this.plan(project, request);
    const dir = await createExportFolder(root, exportFolderName(project.name, this.now()));
    const jobId = randomUUID();
    const progress: ExportProgress = {
      jobId,
      dir,
      total: items.reduce((n, item) => n + Number(item.cube) + Number(item.hald), 0),
      done: 0,
      files: [],
      errors: [],
      finished: false,
    };
    const report = () => this.onProgress({ ...progress, files: [...progress.files], errors: [...progress.errors] });
    report();
    this.port.exportLuts({ jobId, dir, items }, (message) => {
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
}
