import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { lookPipeline, postPipeline } from '@core/lut/bake';
import { identityLut, type Lut3D } from '@core/lut/lut3d';
import { createAdjust, createProject, createSlot } from '@core/project/defaults';
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
    expect(progress.at(-1)).toEqual({ jobId: first.jobId, dir: first.dir, total: 2, done: 0, files: [], errors: [], warnings: [], finished: false });

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
      warnings: [],
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
    expect(await service.plan(project(), { dir: '/p', card: true })).toEqual({ notes: [], cardFile: 'Калибровка.png', luts: [], posts: [], grid: null });
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

describe('посты и сетка (ADR 0017)', () => {
  const LUT_ID = 'aaaaaaaaaaaaaaaa';
  /** Три плитки: полосы (опубликован), однотонное с образом «Плёнка» и LUT, рампа; позиция без фото. */
  function grid(): Project {
    const p = project();
    p.luts[LUT_ID] = { id: LUT_ID, name: 'сепия.cube', size: 3, hash: LUT_ID.padEnd(64, '0'), importedAt: '2026-10-08T00:00:00.000Z' };
    p.looks[0]!.importedLut = LUT_ID;
    for (const [id, name] of [
      ['1111111111111111', '/фото/полосы.jpg'],
      ['2222222222222222', '/фото/однотонное.jpg'],
      ['3333333333333333', 'C:\\фото\\рампа.tif'],
    ] as const) {
      p.assets[id] = { id, path: name, hash: id.padEnd(64, 'f'), w: 1200, h: 1600, format: 'jpeg', icc: 'embedded', importedAt: '' };
    }
    p.slots = [
      { ...createSlot('s1', '1111111111111111'), state: 'published' },
      { ...createSlot('s2', '2222222222222222'), lookId: 'a', adjust: { ...createAdjust(), exposure: 0.5 } },
      createSlot('s3', '3333333333333333'),
      createSlot('s4'),
    ];
    return p;
  }
  const lut = identityLut(3);
  const luts = { loadLut: async () => lut };

  test('запрос: посты, сетка и LUT постов — флаги', () => {
    expect(parseExportRequest({ dir: '/p', posts: true, grid: false, postLuts: true })).toEqual({ dir: '/p', posts: true, grid: false, postLuts: true });
    expect(() => parseExportRequest({ dir: '/p', posts: 1 })).toThrow(/постов/);
    expect(() => parseExportRequest({ dir: '/p', grid: 'да' })).toThrow(/сетки/);
    expect(() => parseExportRequest({ dir: '/p', postLuts: null })).toThrow(/LUT постов/);
  });

  test('посты — в порядке публикации снизу вверх, номер — из плана: опубликованные пропущены, у пустой номер без файла; параметры — плитки', async () => {
    const p = grid();
    const service = new ExportService(new FakePort(), () => {}, { luts });
    const plan = await service.plan(p, { dir: '/проект', posts: true, postLuts: true });
    // Пустая позиция s4 внизу сетки — пост 1 плана: файла нет, номер пропущен (ADR 0022).
    expect(plan.posts.map((item) => [item.fileBase, item.source.path, item.jpeg, item.cube])).toEqual([
      ['2 — рампа', 'C:\\фото\\рампа.tif', true, true],
      ['3 — однотонное', '/фото/однотонное.jpg', true, true],
    ]);
    expect(plan.notes).toEqual([
      'Пост 1 — пустая позиция: номер пропущен, файла нет.',
      'Посты 1–3 ниже опубликованного: на этих местах их не опубликовать.',
    ]);
    expect(plan.posts[0]?.source.hash).toBe('3333333333333333'.padEnd(64, 'f'));
    expect(plan.posts[0]?.params).toEqual({ photo: createAdjust() });
    // Образ плитки вместе с его LUT: LUT загружается, хотя раздел LUT не выбран.
    expect(plan.posts[1]?.params).toEqual(postPipeline({ ...createAdjust(), exposure: 0.5 }, p.looks[0]!.adjust, lut));
    expect(plan.posts[1]?.crop).toEqual(p.slots[1]!.crop);
    expect(plan.grid).toBeNull();
    expect((await service.plan(p, { dir: '/p', postLuts: true })).posts.map((item) => [item.jpeg, item.cube])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  test('сетка — все позиции по порядку, пустая — null, запасной источник — прокси 2048', async () => {
    const p = grid();
    const plan = await new ExportService(new FakePort(), () => {}, { luts }).plan(p, { dir: '/проект', grid: true });
    expect(plan.posts).toEqual([]);
    const item = plan.grid!;
    expect([item.file, item.ratio, item.columns, item.tiles.length]).toEqual(['Сетка.png', '3:4', 3, 4]);
    expect(item.tiles[3]).toBeNull();
    expect(item.tiles[0]).toMatchObject({
      label: 'плитка 1 (полосы)',
      source: { path: '/фото/полосы.jpg' },
      fallback: join('/проект', 'cache', 'proxies', '1111111111111111', '2048.jpg'),
    });
    expect(item.tiles[1]?.params).toEqual(postPipeline({ ...createAdjust(), exposure: 0.5 }, p.looks[0]!.adjust, lut));
  });

  test('имена в подпапке не сталкиваются: карта, сетка, LUT образов и посты', async () => {
    const p = grid();
    p.looks[1]!.name = 'сетка';
    p.looks[2]!.name = '2 — рампа';
    const plan = await new ExportService(new FakePort(), () => {}, { luts }).plan(p, {
      dir: '/p',
      card: true,
      grid: true,
      posts: true,
      lut: { looks: [{ id: 'b', size: 33 }, { id: 'c', size: 33 }], cube: true, hald: true },
    });
    expect(plan.cardFile).toBe('Калибровка.png');
    expect(plan.grid?.file).toBe('Сетка.png');
    expect(plan.luts.map((i) => i.fileBase)).toEqual(['сетка 2', '2 — рампа']);
    expect(plan.posts.map((i) => i.fileBase)).toEqual(['2 — рампа 2', '3 — однотонное']);
  });

  test('закреплённые — последними, с «(закрепить)»; пустая позиция без оговорки, если её нет', async () => {
    const p = grid();
    p.slots = [p.slots[2]!, p.slots[1]!];
    p.grid.pinned = 1;
    const plan = await new ExportService(new FakePort(), () => {}, { luts }).plan(p, { dir: '/p', posts: true });
    expect(plan.posts.map((i) => i.fileBase)).toEqual(['1 — однотонное', '2 — рампа (закрепить)']);
    expect(plan.notes).toEqual([]);
    // Без постов в разделе оговорок плана нет.
    expect((await new ExportService(new FakePort(), () => {}, { luts }).plan(grid(), { dir: '/p', grid: true })).notes).toEqual([]);
  });

  test('публиковать нечего, сетка пуста, копия LUT плитки пропала — ошибка до диалога', async () => {
    const p = grid();
    const service = new ExportService(new FakePort(), () => {}, { luts });
    const published = grid();
    for (const slot of published.slots) slot.state = slot.assetId ? 'published' : 'empty';
    await expect(service.plan(published, { dir: '/p', posts: true })).rejects.toThrow(/нет постов/);
    expect((await service.plan(published, { dir: '/p', grid: true })).grid?.tiles).toHaveLength(4);
    const empty = project();
    await expect(service.plan(empty, { dir: '/p', grid: true })).rejects.toThrow(/нет плиток/);
    const broken = new ExportService(new FakePort(), () => {}, { luts: { loadLut: () => Promise.reject(new Error('LUT «сепия.cube»: файла нет')) } });
    await expect(broken.plan(p, { dir: '/p', posts: true })).rejects.toThrow(/сепия/);
    await expect(broken.plan(p, { dir: '/p', grid: true })).rejects.toThrow(/сепия/);
    // LUT образа нужен только плиткам с фото: без них экспорт LUT другого образа идёт.
    p.slots[1]!.lookId = 'b';
    expect((await broken.plan(p, { dir: '/p', posts: true })).posts).toHaveLength(2);
  });

  test('ход: файлы постов и сетки в счёте, оговорки — отдельным списком', async () => {
    const port = new FakePort();
    const progress: ExportProgress[] = [];
    const service = new ExportService(port, (p) => progress.push(p), { luts });
    const started = await service.start(root, grid(), { dir: '/p', posts: true, postLuts: true, grid: true });
    expect(progress.at(-1)?.total).toBe(5);
    const { job, reply } = port.jobs[0]!;
    expect(job.posts).toHaveLength(2);
    expect(job.grid?.tiles).toHaveLength(4);
    reply({ type: 'file', jobId: started.jobId, file: '1 — рампа.jpg', ok: false, error: 'оригинал не найден: C:\\фото\\рампа.tif' });
    reply({ type: 'file', jobId: started.jobId, file: 'Сетка.png', ok: true, warnings: ['плитка 3 (рампа): из превью'] });
    expect(progress.at(-1)).toMatchObject({
      done: 2,
      files: ['Сетка.png'],
      errors: [{ file: '1 — рампа.jpg', message: 'оригинал не найден: C:\\фото\\рампа.tif' }],
      // Оговорки плана — без файла, первыми.
      warnings: [
        { file: '', message: 'Пост 1 — пустая позиция: номер пропущен, файла нет.' },
        { file: '', message: 'Посты 1–3 ниже опубликованного: на этих местах их не опубликовать.' },
        { file: 'Сетка.png', message: 'плитка 3 (рампа): из превью' },
      ],
    });
  });
});
