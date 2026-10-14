import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { targetGridImage } from '@core/pattern/targetGrid';
import { createAdjust } from '@core/project/defaults';
import type { IndexerResponse, LutExportItem, PlanExportItem } from '@shared/ipc';
import { exportFiles, runExport } from '../../src/indexer/export';
import { readCube, readHald } from '../fixtures/lut';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-export-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function item(fileBase: string, patch: Partial<LutExportItem> = {}): LutExportItem {
  const look = { ...createAdjust(), exposure: 0.3, temp: 20, contrast: 30 };
  return { fileBase, title: fileBase, params: lookPipeline(look), size: 33, cube: true, hald: true, ...patch };
}

async function run(dir: string, items: LutExportItem[], cardFile: string | null = null): Promise<IndexerResponse[]> {
  const messages: IndexerResponse[] = [];
  await runExport({ type: 'export', jobId: 'job', dir, cardFile, luts: items, posts: [], grid: null, plan: null }, (m) => messages.push(m));
  return messages;
}

describe('экспорт LUT в utility process', () => {
  test('.cube 33 и 65 с заголовком, HaldCLUT 512 × 512, 16 бит, без ICC', async () => {
    const dir = join(root, 'formats');
    await mkdir(dir);
    const items = [item('Плёнка'), item('Излом', { size: 65, hald: false, title: 'Излом "крутой"' })];
    const messages = await run(dir, items);
    expect(exportFiles({ cardFile: null, luts: items, posts: [], grid: null, plan: null })).toEqual(['Плёнка.cube', 'Плёнка.png', 'Излом.cube']);
    expect(messages).toEqual([
      { type: 'file', jobId: 'job', file: 'Плёнка.cube', ok: true },
      { type: 'file', jobId: 'job', file: 'Плёнка.png', ok: true },
      { type: 'file', jobId: 'job', file: 'Излом.cube', ok: true },
      { type: 'done', jobId: 'job' },
    ]);
    expect((await readdir(dir)).sort()).toEqual(['Излом.cube', 'Плёнка.cube', 'Плёнка.png'].sort());

    const text = await readFile(join(dir, 'Плёнка.cube'), 'utf8');
    expect(text).toMatch(/^# Gridtone — образ «Плёнка»\n/);
    expect(text).toContain('\nTITLE "Плёнка"\nLUT_3D_SIZE 33\n');
    const cube = await readCube(join(dir, 'Плёнка.cube'));
    const expected = bakeLut(items[0]!.params, 33);
    expect(cube.size).toBe(33);
    for (let i = 0; i < cube.data.length; i++) expect(Math.abs(cube.data[i]! - expected.data[i]!)).toBeLessThanOrEqual(5e-7 + 1e-12);
    const kink = await readCube(join(dir, 'Излом.cube'));
    expect(kink.size).toBe(65);
    expect(kink.title).toBe("Излом 'крутой'");

    const hald = await readHald(join(dir, 'Плёнка.png'));
    expect([hald.width, hald.height, hald.depth, hald.hasProfile]).toEqual([512, 512, 'ushort', false]);
    const grid = bakeLut(items[0]!.params, 64);
    for (let i = 0; i < grid.data.length; i++) {
      expect(Math.abs(hald.lut.data[i]! - grid.data[i]!)).toBeLessThanOrEqual(0.5 / 65535 + 1e-12);
    }
  });

  test('карта пишется первой, затем LUT; без LUT — одна карта', async () => {
    const dir = join(root, 'card');
    await mkdir(dir);
    const items = [item('Калибровка 2', { hald: false })];
    expect(exportFiles({ cardFile: 'Калибровка.png', luts: items, posts: [], grid: null, plan: null })).toEqual(['Калибровка.png', 'Калибровка 2.cube']);
    expect((await run(dir, items, 'Калибровка.png')).map((m) => (m.type === 'file' ? m.file : m.type))).toEqual([
      'Калибровка.png',
      'Калибровка 2.cube',
      'done',
    ]);
    const only = join(root, 'card-only');
    await mkdir(only);
    expect(await run(only, [], 'Калибровка.png')).toEqual([
      { type: 'file', jobId: 'job', file: 'Калибровка.png', ok: true },
      { type: 'done', jobId: 'job' },
    ]);
    expect(await readdir(only)).toEqual(['Калибровка.png']);
  });

  test('существующий файл не перезаписывается: ошибка у него, остальные пишутся', async () => {
    const dir = join(root, 'existing');
    await mkdir(dir);
    await writeFile(join(dir, 'Плёнка.cube'), 'чужой файл');
    const messages = await run(dir, [item('Плёнка', { hald: false }), item('Другой', { hald: false })]);
    expect(messages[0]).toMatchObject({ type: 'file', file: 'Плёнка.cube', ok: false });
    expect(messages[1]).toEqual({ type: 'file', jobId: 'job', file: 'Другой.cube', ok: true });
    expect(messages[2]).toEqual({ type: 'done', jobId: 'job' });
    expect(await readFile(join(dir, 'Плёнка.cube'), 'utf8')).toBe('чужой файл');
  });
});

describe('план контента (ADR 0026)', () => {
  const plan: PlanExportItem = {
    texts: [
      { file: 'План.md', text: '# План контента — Лента\n' },
      { file: 'План.csv', text: '﻿Номер,Подсказка\r\n1,"средний, тёплый"\r\n' },
    ],
    image: { file: 'Цели.png', ratio: '3:4', columns: 3, colors: [[200, 10, 20], null, [0, 128, 255], [7, 8, 9]] },
  };

  test('тексты — байт в байт в UTF-8 (CSV с BOM), Цели.png — пиксели core с вшитым sRGB; после сетки', async () => {
    const dir = join(root, 'plan');
    await mkdir(dir);
    const job = { cardFile: null, luts: [item('Плёнка', { hald: false })], posts: [], grid: null, plan };
    expect(exportFiles(job)).toEqual(['Плёнка.cube', 'План.md', 'План.csv', 'Цели.png']);
    const messages: IndexerResponse[] = [];
    await runExport({ type: 'export', jobId: 'job', dir, ...job }, (m) => messages.push(m));
    expect(messages.map((m) => (m.type === 'file' ? [m.file, m.ok] : m.type))).toEqual([
      ['Плёнка.cube', true],
      ['План.md', true],
      ['План.csv', true],
      ['Цели.png', true],
      'done',
    ]);
    expect(await readFile(join(dir, 'План.md'), 'utf8')).toBe(plan.texts[0]!.text);
    const csv = await readFile(join(dir, 'План.csv'));
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.equals(Buffer.from(plan.texts[1]!.text, 'utf8'))).toBe(true);

    const png = join(dir, 'Цели.png');
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height, meta.channels, meta.depth, meta.hasProfile]).toEqual(['png', 1628, 1444, 3, 'uchar', true]);
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const expected = targetGridImage(plan.image!.colors, '3:4', 3);
    expect(Buffer.from(expected.data).equals(data)).toBe(true);
  });

  test('существующий файл плана не перезаписывается', async () => {
    const dir = join(root, 'plan-existing');
    await mkdir(dir);
    await writeFile(join(dir, 'План.md'), 'чужой план');
    const messages: IndexerResponse[] = [];
    await runExport({ type: 'export', jobId: 'job', dir, cardFile: null, luts: [], posts: [], grid: null, plan }, (m) => messages.push(m));
    expect(messages[0]).toMatchObject({ type: 'file', file: 'План.md', ok: false });
    expect(messages.slice(1, 3).map((m) => m.type === 'file' && m.ok)).toEqual([true, true]);
    expect(await readFile(join(dir, 'План.md'), 'utf8')).toBe('чужой план');
  });
});
