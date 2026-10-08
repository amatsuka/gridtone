import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { lookPipeline } from '@core/lut/bake';
import { identityLut, type Lut3D } from '@core/lut/lut3d';
import { createAdjust, createProject } from '@core/project/defaults';
import type { Project } from '@core/project/types';
import type { ExportProgress, IndexerResponse, LutExportJob } from '@shared/ipc';
import { ExportService, createExportFolder, lutExportItems, parseExportRequest, type LutExportPort } from '../../src/main/export';

class FakePort implements LutExportPort {
  readonly jobs: { job: Omit<LutExportJob, 'type'>; reply: (message: IndexerResponse) => void }[] = [];
  exportLuts(job: Omit<LutExportJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    this.jobs.push({ job, reply: onMessage });
  }
}

function project(): Project {
  const p = createProject('Сетка');
  p.looks = [
    { id: 'a', name: 'Плёнка', adjust: { ...createAdjust(), exposure: 0.3 } },
    { id: 'b', name: 'плёнка', adjust: createAdjust() },
    { id: 'c', name: 'Тёплый / холодный', adjust: { ...createAdjust(), temp: 40 } },
  ];
  return p;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-export-main-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('запрос экспорта', () => {
  test('проверяется форма запроса из renderer', () => {
    const ok = { dir: '/p', lut: { looks: [{ id: 'a', size: 65 }], cube: true, hald: false } };
    expect(parseExportRequest(ok)).toEqual(ok);
    expect(parseExportRequest({ dir: '/p' })).toEqual({ dir: '/p' });
    expect(() => parseExportRequest(null)).toThrow();
    expect(() => parseExportRequest({ dir: 1 })).toThrow();
    expect(() => parseExportRequest({ dir: '/p', lut: { looks: [{ id: 'a', size: 34 }], cube: true, hald: false } })).toThrow();
    expect(() => parseExportRequest({ dir: '/p', lut: { looks: [{ id: 1, size: 33 }], cube: true, hald: false } })).toThrow();
    expect(() => parseExportRequest({ dir: '/p', lut: { looks: [], cube: 'да', hald: false } })).toThrow();
  });

  test('образы → задачи: имена файлов безопасные и без повторов, параметры — проход образа', () => {
    const p = project();
    const items = lutExportItems(p, {
      looks: [
        { id: 'a', size: 33 },
        { id: 'b', size: 65 },
        { id: 'c', size: 33 },
      ],
      cube: true,
      hald: true,
    });
    expect(items.map((i) => [i.fileBase, i.title, i.size])).toEqual([
      ['Плёнка', 'Плёнка', 33],
      ['плёнка 2', 'плёнка', 65],
      ['Тёплый - холодный', 'Тёплый / холодный', 33],
    ]);
    expect(items[0]?.params).toEqual(lookPipeline(p.looks[0]!.adjust));
  });

  test('нечего экспортировать, образа нет, образ дважды — ошибка', async () => {
    const p = project();
    expect(() => lutExportItems(p, { looks: [{ id: 'a', size: 33 }], cube: false, hald: false })).toThrow(/формат/);
    expect(() => lutExportItems(p, { looks: [], cube: true, hald: false })).toThrow(/образ/);
    expect(() => lutExportItems(p, { looks: [{ id: 'x', size: 33 }], cube: true, hald: false })).toThrow(/удалён/);
    expect(() =>
      lutExportItems(p, {
        looks: [
          { id: 'a', size: 33 },
          { id: 'a', size: 65 },
        ],
        cube: true,
        hald: false,
      }),
    ).toThrow(/дважды/);
    await expect(new ExportService(new FakePort(), () => {}).plan(p, { dir: '/p' })).rejects.toThrow(/Нечего/);
  });
});

describe('образ с импортированным LUT (ADR 0015)', () => {
  const LUT_ID = '0123456789abcdef';
  function withLut(): Project {
    const p = project();
    p.luts[LUT_ID] = { id: LUT_ID, name: 'сепия.cube', size: 3, hash: LUT_ID.padEnd(64, '0'), importedAt: '2026-10-08T00:00:00.000Z' };
    p.looks[0]!.importedLut = LUT_ID;
    return p;
  }
  const request = { dir: '/p', lut: { looks: [{ id: 'a', size: 33 as const }, { id: 'c', size: 33 as const }], cube: true, hald: false } };

  test('LUT образа запекается вместе с его коррекцией; без загруженного LUT — ошибка', async () => {
    const lut = identityLut(3);
    const loaded: string[] = [];
    const service = new ExportService(new FakePort(), () => {}, {
      luts: {
        loadLut: async (id: string): Promise<Lut3D> => {
          loaded.push(id);
          return lut;
        },
      },
    });
    const items = await service.plan(withLut(), request);
    expect(loaded).toEqual([LUT_ID]);
    expect(items[0]?.params).toEqual(lookPipeline(withLut().looks[0]!.adjust, lut));
    expect(items[1]?.params.lut).toBeUndefined();
    expect(() => lutExportItems(withLut(), request.lut)).toThrow(/не загружен/);
  });

  test('копия LUT пропала — экспорт не начинается, папка не создаётся', async () => {
    const port = new FakePort();
    const service = new ExportService(port, () => {}, {
      luts: { loadLut: () => Promise.reject(new Error('LUT «сепия.cube»: файла нет в папке luts/ проекта')) },
    });
    await expect(service.start(root, withLut(), request)).rejects.toThrow(/сепия\.cube/);
    expect(port.jobs).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('ExportService', () => {
  test('каждый экспорт — новая подпапка, существующие не трогаются', async () => {
    expect(await createExportFolder(root, 'Экспорт')).toBe(join(root, 'Экспорт'));
    expect(await createExportFolder(root, 'Экспорт')).toBe(join(root, 'Экспорт (2)'));
    expect(await createExportFolder(root, 'Экспорт')).toBe(join(root, 'Экспорт (3)'));
    await expect(createExportFolder(join(root, 'нет такой'), 'Экспорт')).rejects.toThrow();
  });

  test('запуск: подпапка по имени проекта и времени, задача в utility process, ход событиями', async () => {
    const port = new FakePort();
    const progress: ExportProgress[] = [];
    const service = new ExportService(port, (p) => progress.push(p), { now: () => new Date(2026, 9, 8, 7, 5, 3) });
    const request = { dir: '/p', lut: { looks: [{ id: 'a', size: 33 as const }], cube: true, hald: true } };

    const first = await service.start(root, project(), request);
    expect(first.dir).toBe(join(root, 'Сетка — экспорт 2026-10-08 07-05-03'));
    expect((await stat(first.dir)).isDirectory()).toBe(true);
    const { job, reply } = port.jobs[0]!;
    expect(job.jobId).toBe(first.jobId);
    expect(job.dir).toBe(first.dir);
    expect(job.items.map((i) => i.fileBase)).toEqual(['Плёнка']);
    expect(progress.at(-1)).toEqual({ jobId: first.jobId, dir: first.dir, total: 2, done: 0, files: [], errors: [], finished: false });

    reply({ type: 'file', jobId: first.jobId, file: 'Плёнка.cube', ok: true });
    reply({ type: 'file', jobId: first.jobId, file: 'Плёнка.png', ok: false, error: 'диск полон' });
    reply({ type: 'done', jobId: first.jobId });
    expect(progress.at(-1)).toEqual({
      jobId: first.jobId,
      dir: first.dir,
      total: 2,
      done: 2,
      files: ['Плёнка.cube'],
      errors: [{ file: 'Плёнка.png', message: 'диск полон' }],
      finished: true,
    });

    // Повторный экспорт в ту же секунду — рядом, в «(2)».
    const second = await service.start(root, project(), request);
    expect(second.dir).toBe(join(root, 'Сетка — экспорт 2026-10-08 07-05-03 (2)'));
    expect((await readdir(root)).sort()).toEqual(['Сетка — экспорт 2026-10-08 07-05-03', 'Сетка — экспорт 2026-10-08 07-05-03 (2)']);
  });
});
