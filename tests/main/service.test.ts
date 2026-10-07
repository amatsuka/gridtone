import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createAdjust, createSlot } from '@core/project/defaults';
import { PatchError } from '@core/project/patch';
import { parseProject, serializeProject } from '@core/project/serialize';
import type { AssetRef } from '@core/project/types';
import type {
  ImportProgress,
  IndexJob,
  IndexedAsset,
  IndexerResponse,
  ProjectSnapshot,
  ProjectStatus,
} from '@shared/ipc';
import { proxyFile } from '../../src/main/project/paths';
import { ProjectService, type IndexerPort } from '../../src/main/project/service';

class FakeIndexer implements IndexerPort {
  readonly jobs: { job: Omit<IndexJob, 'type'>; reply: (message: IndexerResponse) => void }[] = [];
  run(job: Omit<IndexJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    this.jobs.push({ job, reply: onMessage });
  }
  last() {
    const entry = this.jobs.at(-1);
    if (!entry) throw new Error('индексатор не вызывался');
    return entry;
  }
}

function asset(path: string, id: string): IndexedAsset {
  return { id, path, hash: id.padEnd(64, '0'), w: 3000, h: 4000, format: 'jpeg', icc: 'assumed-srgb' };
}

let root: string;
let indexer: FakeIndexer;
let service: ProjectService;
let snapshots: (ProjectSnapshot | null)[];
let progress: ImportProgress[];
let statuses: ProjectStatus[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-service-'));
  indexer = new FakeIndexer();
  snapshots = [];
  progress = [];
  statuses = [];
  service = new ProjectService(
    indexer,
    {
      snapshot: (s) => snapshots.push(s),
      status: (s) => statuses.push(s),
      importProgress: (p) => progress.push(p),
    },
    { autosaveDelayMs: 5 },
  );
});
afterEach(async () => {
  // Сначала дописываем автосохранение: иначе оно пишет в папку, которую rm уже удаляет.
  await service.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('импорт', () => {
  test('порядок в сетке — порядок файлов, даже если индексатор ответил вразнобой', async () => {
    await service.create(join(root, 'p'));
    service.importFiles(['/ph/b.jpg', '/ph/a.jpg', '/ph/c.png', '/ph/x.gif', '/ph/IMG_10.jpg', '/ph/IMG_9.jpg']);

    const { job, reply } = indexer.last();
    expect(job.items.map((i) => i.path)).toEqual(['/ph/a.jpg', '/ph/b.jpg', '/ph/c.png', '/ph/IMG_9.jpg', '/ph/IMG_10.jpg']);

    const ok = (index: number, id: string): IndexerResponse => ({
      type: 'item',
      jobId: job.jobId,
      index,
      ok: true,
      asset: asset(job.items[index]?.path ?? '', id),
    });
    reply(ok(2, 'cccccccccccccccc'));
    expect(service.snapshot()?.project.slots).toHaveLength(0); // ждём первый файл
    reply(ok(0, 'aaaaaaaaaaaaaaaa'));
    reply(ok(4, 'eeeeeeeeeeeeeeee'));
    reply(ok(1, 'bbbbbbbbbbbbbbbb'));
    reply({ type: 'item', jobId: job.jobId, index: 3, ok: false, code: 'failed', error: 'битый файл' });
    reply({ type: 'done', jobId: job.jobId });

    const snap = service.snapshot();
    const paths = snap?.project.slots.map((s) => snap.project.assets[s.assetId ?? '']?.path);
    expect(paths).toEqual(['/ph/a.jpg', '/ph/b.jpg', '/ph/c.png', '/ph/IMG_10.jpg']);
    expect(progress.at(-1)).toMatchObject({ total: 6, done: 6, added: 4, duplicates: 0, finished: true });
    expect(progress.at(-1)?.errors).toEqual([
      { path: '/ph/x.gif', message: 'Формат не поддерживается' },
      { path: '/ph/IMG_9.jpg', message: 'битый файл' },
    ]);
  });

  test('одинаковое содержимое добавляется один раз', async () => {
    await service.create(join(root, 'p'));
    service.importFiles(['/ph/a.jpg', '/ph/a-copy.jpg']);
    const { job, reply } = indexer.last();
    for (const [index, item] of job.items.entries()) {
      reply({ type: 'item', jobId: job.jobId, index, ok: true, asset: asset(item.path, 'aaaaaaaaaaaaaaaa') });
    }
    reply({ type: 'done', jobId: job.jobId });
    expect(service.snapshot()?.project.slots).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({ added: 1, duplicates: 1 });
  });

  test('импорт попадает на диск', async () => {
    const dir = join(root, 'p');
    await service.create(dir);
    service.importFiles(['/ph/a.jpg']);
    const { job, reply } = indexer.last();
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/a.jpg', 'aaaaaaaaaaaaaaaa') });
    await service.close();

    const saved = parseProject(await readFile(join(dir, 'project.json'), 'utf8'));
    expect(saved.slots).toHaveLength(1);
    expect(saved.assets['aaaaaaaaaaaaaaaa']?.path).toBe('/ph/a.jpg');
  });

  test('ответы для закрытого проекта игнорируются', async () => {
    await service.create(join(root, 'p'));
    service.importFiles(['/ph/a.jpg']);
    const { job, reply } = indexer.last();
    await service.close();
    const before = snapshots.length;
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/a.jpg', 'aaaaaaaaaaaaaaaa') });
    expect(snapshots.length).toBe(before);
    expect(service.snapshot()).toBeNull();
  });

  test('протокол отдаёт только ассеты открытого проекта', async () => {
    const dir = join(root, 'p');
    await service.create(dir);
    service.importFiles(['/ph/a.jpg']);
    const { job, reply } = indexer.last();
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/a.jpg', 'aaaaaaaaaaaaaaaa') });

    expect(service.proxyPath('aaaaaaaaaaaaaaaa', 512)).toBe(proxyFile(dir, 'aaaaaaaaaaaaaaaa', 512));
    expect(service.proxyPath('bbbbbbbbbbbbbbbb', 512)).toBeNull();
    expect(service.proxyPath('../../etc/passwd', 512)).toBeNull();
  });
});

describe('открытие', () => {
  test('сверяет кэш и пересобирает пропавшие прокси из неизменённых оригиналов', async () => {
    const dir = join(root, 'p');
    const photos = join(root, 'photos');
    await mkdir(photos);
    const present = join(photos, 'present.jpg');
    await writeFile(present, 'x');

    await service.create(dir);
    await service.close();

    // Три ассета: прокси на месте; прокси нет, оригинал есть; нет ни того, ни другого.
    const project = parseProject(await readFile(join(dir, 'project.json'), 'utf8'));
    const refs: AssetRef[] = [
      { ...asset('/gone/cached.jpg', '1111111111111111'), importedAt: '2026-10-06T00:00:00.000Z' },
      { ...asset(present, '2222222222222222'), importedAt: '2026-10-06T00:00:00.000Z' },
      { ...asset('/gone/lost.jpg', '3333333333333333'), importedAt: '2026-10-06T00:00:00.000Z' },
    ];
    for (const ref of refs) {
      project.assets[ref.id] = ref;
      project.slots.push(createSlot(`slot-${ref.id}`, ref.id));
    }
    await writeFile(join(dir, 'project.json'), serializeProject(project));
    for (const size of [512, 2048] as const) {
      const file = proxyFile(dir, '1111111111111111', size);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'jpeg');
    }

    const opened = await service.open(dir);
    expect(opened.assets).toEqual({
      '1111111111111111': { proxy: 'ready', original: 'missing' },
      '2222222222222222': { proxy: 'pending', original: 'ok' },
      '3333333333333333': { proxy: 'failed', original: 'missing' },
    });

    const { job, reply } = indexer.last();
    expect(job.items).toEqual([{ path: present, expectHash: refs[1]?.hash }]);
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset(present, '2222222222222222') });
    expect(service.snapshot()?.assets['2222222222222222']).toEqual({ proxy: 'ready', original: 'ok' });

    // Открытие само по себе проект не переписывает.
    await service.close();
    expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe(serializeProject(project));
  });

  test('битый проект не закрывает текущий', async () => {
    await service.create(join(root, 'good'));
    const bad = join(root, 'bad');
    await mkdir(bad);
    await writeFile(join(bad, 'project.json'), 'not json');
    await expect(service.open(bad)).rejects.toThrow();
    expect(service.snapshot()?.project.name).toBe('good');
  });
});

describe('правки из renderer', () => {
  async function projectWithPhoto(dir: string): Promise<void> {
    await service.create(dir);
    service.importFiles(['/ph/a.jpg']);
    const { job, reply } = indexer.last();
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/a.jpg', 'aaaaaaaaaaaaaaaa') });
  }

  test('патч применяется, сохраняется на диск, а renderer получает только статус', async () => {
    const dir = join(root, 'p');
    await projectWithPhoto(dir);
    const snapshotsBefore = snapshots.length;

    service.applyPatches({ dir, seq: 3, patches: [{ op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 0.5 }] });
    expect(snapshots.length).toBe(snapshotsBefore);
    expect(statuses.at(-1)).toEqual({ dir, save: { state: 'pending' }, patchSeq: 3 });
    expect(service.snapshot()).toMatchObject({ patchSeq: 3 });

    await service.close();
    const saved = parseProject(await readFile(join(dir, 'project.json'), 'utf8'));
    expect(saved.slots[0]?.adjust).toEqual({ ...createAdjust(), exposure: 0.5 });
  });

  test('перестановка и образ из renderer доходят до диска', async () => {
    const dir = join(root, 'p');
    await projectWithPhoto(dir);
    service.importFiles(['/ph/b.jpg']);
    const { job, reply } = indexer.last();
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/b.jpg', 'bbbbbbbbbbbbbbbb') });
    const [first, second] = service.snapshot()?.project.slots ?? [];
    const look = { id: 'look-1', name: 'Образ 1', adjust: { ...createAdjust(), exposure: 1 } };

    service.applyPatches({
      dir,
      seq: 1,
      patches: [
        { op: 'replace', path: ['slots', 0], value: second },
        { op: 'replace', path: ['slots', 1], value: first },
        { op: 'add', path: ['looks', 0], value: look },
        { op: 'add', path: ['slots', 0, 'lookId'], value: 'look-1' },
      ],
    });

    await service.close();
    const saved = parseProject(await readFile(join(dir, 'project.json'), 'utf8'));
    expect(saved.slots.map((slot) => slot.assetId)).toEqual(['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
    expect(saved.slots[0]?.lookId).toBe('look-1');
    expect(saved.looks).toEqual([look]);
  });

  test('снимок после изменения в main несёт номер последнего применённого пакета', async () => {
    const dir = join(root, 'p');
    await projectWithPhoto(dir);
    service.applyPatches({ dir, seq: 9, patches: [{ op: 'replace', path: ['slots', 0, 'adjust', 'temp'], value: 20 }] });
    service.importFiles(['/ph/b.jpg']);
    const { job, reply } = indexer.last();
    reply({ type: 'item', jobId: job.jobId, index: 0, ok: true, asset: asset('/ph/b.jpg', 'bbbbbbbbbbbbbbbb') });
    expect(snapshots.at(-1)).toMatchObject({ patchSeq: 9 });
    expect(snapshots.at(-1)?.project.slots[0]?.adjust.temp).toBe(20);
  });

  test('пакет для другого проекта отвергается', async () => {
    const dir = join(root, 'p');
    await projectWithPhoto(dir);
    expect(() =>
      service.applyPatches({
        dir: join(root, 'other'),
        seq: 1,
        patches: [{ op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 }],
      }),
    ).toThrow();
    expect(service.snapshot()?.project.slots[0]?.adjust.exposure).toBe(0);
  });

  test('запрещённый патч не меняет проект и не запускает сохранение', async () => {
    const dir = join(root, 'p');
    await projectWithPhoto(dir);
    await service.save();
    expect(() =>
      service.applyPatches({ dir, seq: 1, patches: [{ op: 'replace', path: ['assets', 'aaaaaaaaaaaaaaaa', 'path'], value: '/x' }] }),
    ).toThrow(PatchError);
    expect(service.snapshot()).toMatchObject({ patchSeq: 0, save: { state: 'saved' } });
    expect(service.snapshot()?.project.assets['aaaaaaaaaaaaaaaa']?.path).toBe('/ph/a.jpg');
  });
});
