import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { createAdjust } from '@core/project/defaults';
import type { IndexerResponse, LutExportItem } from '@shared/ipc';
import { exportLuts, lutExportFiles } from '../../src/indexer/export';
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

async function run(dir: string, items: LutExportItem[]): Promise<IndexerResponse[]> {
  const messages: IndexerResponse[] = [];
  await exportLuts({ type: 'export-lut', jobId: 'job', dir, items }, (m) => messages.push(m));
  return messages;
}

describe('экспорт LUT в utility process', () => {
  test('.cube 33 и 65 с заголовком, HaldCLUT 512 × 512, 16 бит, без ICC', async () => {
    const dir = join(root, 'formats');
    await mkdir(dir);
    const items = [item('Плёнка'), item('Излом', { size: 65, hald: false, title: 'Излом "крутой"' })];
    const messages = await run(dir, items);
    expect(lutExportFiles(items)).toEqual(['Плёнка.cube', 'Плёнка.png', 'Излом.cube']);
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
