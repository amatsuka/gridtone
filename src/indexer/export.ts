// Экспорт в utility process (docs/decisions/0014-lut-export.md, 0016-calibration-card.md, 0017-post-export.md,
// 0026-content-plan.md): запекание 33³–65³, PNG через sharp, посты и сетка из оригиналов, план контента не
// подвешивают ни main, ни интерфейс.
// Папку задачи создаёт main; файлы пишутся с флагом wx — существующий файл не перезаписывается никогда.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bakeLut } from '@core/lut/bake';
import { lookCubeComments, writeCube } from '@core/lut/cube';
import { HALD_LEVEL, haldGeometry, lutToHald } from '@core/lut/hald';
import { targetGridImage } from '@core/pattern/targetGrid';
import type { ExportJob, IndexerResponse, LutExportItem, PlanExportItem } from '@shared/ipc';
import { cardPng } from './calibration';
import { gridPng, postCube, postJpeg, type Rendered } from './posts';

type ExportPlan = Pick<ExportJob, 'cardFile' | 'luts' | 'posts' | 'grid' | 'plan'>;

/**
 * Имена файлов задачи по порядку записи: карта; `.cube` и HaldCLUT каждого образа; посты в порядке
 * публикации — JPEG и `.cube`; сетка; план контента — `План.md`, `План.csv`, `Цели.png`.
 */
export function exportFiles(job: ExportPlan): string[] {
  return outputs(job).map(([file]) => file);
}

type Output = [file: string, render: () => Promise<Rendered>];

const plain = async (data: string | Buffer | Promise<Buffer>): Promise<Rendered> => ({
  data: typeof data === 'string' ? Buffer.from(data, 'utf8') : await data,
  warnings: [],
});

function outputs({ cardFile, luts, posts, grid, plan }: ExportPlan): Output[] {
  const list: Output[] = cardFile === null ? [] : [[cardFile, () => plain(cardPng())]];
  for (const item of luts) {
    if (item.cube) list.push([`${item.fileBase}.cube`, () => plain(cubeText(item))]);
    if (item.hald) list.push([`${item.fileBase}.png`, () => plain(haldPng(item))]);
  }
  for (const item of posts) {
    if (item.jpeg) list.push([`${item.fileBase}.jpg`, () => postJpeg(item)]);
    if (item.cube) list.push([`${item.fileBase}.cube`, async () => postCube(item)]);
  }
  if (grid) list.push([grid.file, () => gridPng(grid)]);
  for (const { file, text } of plan?.texts ?? []) list.push([file, () => plain(text)]);
  const image = plan?.image;
  if (image) list.push([image.file, () => plain(targetsPng(image))]);
  return list;
}

/** `Цели.png`: пиксели целевой сетки считает core, RGB 8 бит со вшитым sRGB — как `Сетка.png`. */
export async function targetsPng(image: NonNullable<PlanExportItem['image']>): Promise<Buffer> {
  const { width, height, data } = targetGridImage(image.colors, image.ratio, image.columns);
  return sharp(data, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .png({ compressionLevel: 6 })
    .toBuffer();
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

/**
 * Пишет файлы задачи по одному и сообщает о каждом. Ошибка одного файла — пост без оригинала, занятое
 * имя — не останавливает остальные.
 */
export async function runExport(job: ExportJob, post: (message: IndexerResponse) => void): Promise<void> {
  const { jobId, dir } = job;
  for (const [file, render] of outputs(job)) {
    try {
      const { data, warnings } = await render();
      await writeFile(join(dir, file), data, { flag: 'wx' });
      post({ type: 'file', jobId, file, ok: true, ...(warnings.length > 0 ? { warnings } : {}) });
    } catch (err) {
      post({ type: 'file', jobId, file, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  post({ type: 'done', jobId });
}
