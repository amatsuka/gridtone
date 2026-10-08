// Экспорт в utility process (docs/decisions/0014-lut-export.md, 0016-calibration-card.md): запекание
// 33³–65³ и PNG через sharp не подвешивают ни main, ни интерфейс. Папку задачи создаёт main; файлы
// пишутся с флагом wx — существующий файл не перезаписывается никогда.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bakeLut } from '@core/lut/bake';
import { lookCubeComments, writeCube } from '@core/lut/cube';
import { HALD_LEVEL, haldGeometry, lutToHald } from '@core/lut/hald';
import type { ExportJob, IndexerResponse, LutExportItem } from '@shared/ipc';
import { cardPng } from './calibration';

/** Имена файлов задачи по порядку записи: карта, затем для каждого образа `.cube` и HaldCLUT. */
export function exportFiles(job: Pick<ExportJob, 'cardFile' | 'luts'>): string[] {
  return outputs(job).map(([file]) => file);
}

type Output = [file: string, render: () => Promise<string | Buffer>];

function outputs({ cardFile, luts }: Pick<ExportJob, 'cardFile' | 'luts'>): Output[] {
  const list: Output[] = cardFile === null ? [] : [[cardFile, cardPng]];
  for (const item of luts) {
    if (item.cube) list.push([`${item.fileBase}.cube`, async () => cubeText(item)]);
    if (item.hald) list.push([`${item.fileBase}.png`, () => haldPng(item)]);
  }
  return list;
}

/** `.cube` образа: решётка item.size³, 6 знаков, домен 0..1. */
export function cubeText(item: LutExportItem): string {
  return writeCube(bakeLut(item.params, item.size, item.title), lookCubeComments(item.title));
}

/**
 * HaldCLUT уровня 8: решётка 64³ запекается заново, а не пересчитывается из `.cube`, — PNG 512 × 512,
 * 16 бит, без ICC. Глубину sharp берёт из типа массива (Uint16Array), а запись в 16 бит — из
 * toColourspace('rgb16'): без него PNG молча станет 8-битным.
 */
export async function haldPng(item: LutExportItem): Promise<Buffer> {
  const image = lutToHald(bakeLut(item.params, haldGeometry(HALD_LEVEL).size));
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .toColourspace('rgb16')
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** Пишет файлы задачи по одному и сообщает о каждом. Ошибка одного файла не останавливает остальные. */
export async function runExport(job: ExportJob, post: (message: IndexerResponse) => void): Promise<void> {
  const { jobId, dir } = job;
  for (const [file, render] of outputs(job)) {
    try {
      await writeFile(join(dir, file), await render(), { flag: 'wx' });
      post({ type: 'file', jobId, file, ok: true });
    } catch (err) {
      post({ type: 'file', jobId, file, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  post({ type: 'done', jobId });
}
