import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { analyzeGrid } from '@core/metrics/grid';
import { tileMetrics } from '@core/metrics/tile';
import { createAdjust, createCrop, createSlot } from '@core/project/defaults';
import { proxyRelPath } from '@shared/cache';
import { indexFile } from '../../src/indexer/proxies';
import { analyzeFolder, folderPhotos, formatReport, photoMetrics } from '../../scripts/analyzeFolder';
import { writePixelFixture, type Rgb } from '../fixtures/generate';

let root: string;
let photos: string;

const gray = (v: number): Rgb => ({ r: v, g: v, b: v });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-analyze-'));
  photos = join(root, 'photos');
  // Шахматка из 9 серых, плитка 5 на светлом месте темнее. Имена 1…9 и 10: сортировка по числу, а не по строке.
  const levels = [200, 70, 205, 66, 150, 74, 196, 62, 210];
  for (const [i, v] of levels.entries()) await writePixelFixture(photos, `${i + 1}`, 300, 400, () => gray(v));
  await writeFile(join(photos, 'notes.txt'), 'не фото');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('npm run analyze', () => {
  test('фото папки по имени, как при импорте; не-фото пропускаются', async () => {
    await writePixelFixture(photos, '10', 300, 400, () => gray(120));
    const files = await folderPhotos(photos);
    expect(files.map((f) => basename(f))).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg', '8.jpg', '9.jpg', '10.jpg']);
    await rm(join(photos, '10.jpg'));
  });

  test('признаки — как у воркера по прокси 512 из индексатора', async () => {
    const file = join(photos, '3.jpg');
    const asset = await indexFile({ path: file }, join(root, 'cache'));
    const { data, info } = await sharp(join(root, 'cache', proxyRelPath(asset.id, 512)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image = { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    const fromProxy = tileMetrics(image, createCrop(), '3:4', { photo: createAdjust() });
    expect(await photoMetrics(file, '3:4')).toEqual(fromProxy);
  });

  test('анализ — тот же analyzeGrid; в отчёте ритм, гармония и выброс', async () => {
    const report = await analyzeFolder(photos);
    expect(report.tiles).toHaveLength(9);
    const expected = analyzeGrid(
      { grid: { ratio: '3:4', columns: 3, pinned: 0 }, slots: report.tiles.map((_, i) => createSlot(`s${i}`, 'photo')) },
      Object.fromEntries(report.tiles.map((t, i) => [`s${i}`, t.metrics])),
    );
    expect(report.analysis.metrics).toEqual(expected.metrics);
    expect(report.analysis.outliers.map((o) => o.index)).toEqual([4]);
    const text = formatReport(report);
    expect(text).toContain('Ритм: Шахматка');
    expect(text).toContain('Гармония: нейтральная сетка');
    expect(text).toMatch(/Выбросы \(1\):\n\s+5\s+яркость 0\.\d\d → 0\.\d\d/);
  });
});
