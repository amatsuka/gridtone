import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { lookPipeline } from '@core/lut/bake';
import { identityLut, type Lut3D } from '@core/lut/lut3d';
import { createAdjust, createProject } from '@core/project/defaults';
import type { Project } from '@core/project/types';
import type { CardReport } from '@core/lut/calibration';
import type { CardCheckJob, ExportJob, ExportProgress, IndexerResponse } from '@shared/ipc';
import {
  ExportService,
  createExportFolder,
  lutExportItems,
  parseCalibrationRequest,
  parseExportRequest,
  type ExportPort,
} from '../../src/main/export';

const GEOMETRY: CardReport = { verdict: 'geometry', problem: 'proportions', width: 10, height: 10 };

class FakePort implements ExportPort {
  readonly jobs: { job: Omit<ExportJob, 'type'>; reply: (message: IndexerResponse) => void }[] = [];
  readonly checks: Omit<CardCheckJob, 'type'>[] = [];
  runExport(job: Omit<ExportJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    this.jobs.push({ job, reply: onMessage });
  }
  async checkCard(job: Omit<CardCheckJob, 'type'>): Promise<CardReport> {
    this.checks.push(job);
    return GEOMETRY;
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
    expect(parseExportRequest({ dir: '/p', card: true })).toEqual({ dir: '/p', card: true });
    expect(() => parseExportRequest({ dir: '/p', card: 'да' })).toThrow(/карты/);
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
    const { luts: items } = await service.plan(withLut(), request);
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
    expect(job.cardFile).toBeNull();
    expect(job.luts.map((i) => i.fileBase)).toEqual(['Плёнка']);
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

describe('калибровочная карта (ADR 0016)', () => {
  test('карта — свой раздел экспорта: можно без LUT; образ «Калибровка» не затирает файл карты', async () => {
    const port = new FakePort();
    const progress: ExportProgress[] = [];
    const service = new ExportService(port, (p) => progress.push(p));
    expect(await service.plan(project(), { dir: '/p', card: true })).toEqual({ cardFile: 'Калибровка.png', luts: [] });
    await expect(service.plan(project(), { dir: '/p', card: false })).rejects.toThrow(/Нечего/);

    const started = await service.start(root, project(), { dir: '/p', card: true });
    expect(port.jobs[0]?.job).toMatchObject({ dir: started.dir, cardFile: 'Калибровка.png', luts: [] });
    expect(progress.at(-1)?.total).toBe(1);

    const p = project();
    p.looks[0]!.name = 'калибровка';
    const plan = await service.plan(p, { dir: '/p', card: true, lut: { looks: [{ id: 'a', size: 33 }], cube: true, hald: true } });
    expect(plan.cardFile).toBe('Калибровка.png');
    expect(plan.luts.map((i) => i.fileBase)).toEqual(['калибровка 2']);
    // Без карты имя образа не меняется.
    const plain = await service.plan(p, { dir: '/p', lut: { looks: [{ id: 'a', size: 33 }], cube: true, hald: true } });
    expect(plain.luts.map((i) => i.fileBase)).toEqual(['калибровка']);
  });

  test('ожидание — проход образа с его LUT; нет образа или копии LUT — ошибка до диалога', async () => {
    const LUT_ID = 'fedcba9876543210';
    const p = project();
    p.luts[LUT_ID] = { id: LUT_ID, name: 'сепия.cube', size: 3, hash: LUT_ID.padEnd(64, '0'), importedAt: '2026-10-08T00:00:00.000Z' };
    p.looks[2]!.importedLut = LUT_ID;
    const lut = identityLut(3);
    const port = new FakePort();
    const service = new ExportService(port, () => {}, { luts: { loadLut: async () => lut } });

    const plain = await service.cardParams(p, 'a');
    expect(plain.look.name).toBe('Плёнка');
    expect(plain.params).toEqual(lookPipeline(p.looks[0]!.adjust));
    const withLut = await service.cardParams(p, 'c');
    expect(withLut.params).toEqual(lookPipeline(p.looks[2]!.adjust, lut));
    await expect(service.cardParams(p, 'нет')).rejects.toThrow(/удалён/);

    const broken = new ExportService(port, () => {}, { luts: { loadLut: () => Promise.reject(new Error('LUT «сепия.cube»: файла нет')) } });
    await expect(broken.cardParams(p, 'c')).rejects.toThrow(/сепия\.cube/);

    expect(await service.checkCard('/карта.jpg', withLut.params)).toBe(GEOMETRY);
    expect(port.checks).toHaveLength(1);
    expect(port.checks[0]).toMatchObject({ path: '/карта.jpg', params: withLut.params });
  });

  test('запрос проверки карты из renderer проверяется', () => {
    expect(parseCalibrationRequest({ dir: '/p', lookId: 'a' })).toEqual({ dir: '/p', lookId: 'a' });
    expect(() => parseCalibrationRequest({ dir: '/p' })).toThrow();
    expect(() => parseCalibrationRequest({ dir: 1, lookId: 'a' })).toThrow();
    expect(() => parseCalibrationRequest(null)).toThrow();
  });
});
