import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyPipeline } from '@core/color/pipeline';
import type { Rgb as Rgb01 } from '@core/color/srgb';
import { bakeLut, postPipeline } from '@core/lut/bake';
import { applyAffine, feedFrameTransform } from '@core/project/crop';
import { createAdjust, createCrop } from '@core/project/defaults';
import { GRID_BACKGROUND, GRID_EMPTY, gridLayout } from '@core/project/publish';
import type { Crop } from '@core/project/types';
import type { ExportSource, GridExportItem, GridTileItem, IndexerResponse, PostExportItem } from '@shared/ipc';
import { exportFiles, runExport } from '../../src/indexer/export';
import { renderProxy } from '../../src/indexer/proxies';
import { MARKER, writeFixture, writePixelFixture, type Rgb } from '../fixtures/generate';
import { readCube } from '../fixtures/lut';

let root: string;
let photos: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-posts-'));
  photos = join(root, 'photos');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function source(path: string): Promise<ExportSource> {
  return { path, hash: createHash('sha256').update(await readFile(path)).digest('hex') };
}

function post(fileBase: string, src: ExportSource, patch: Partial<PostExportItem> = {}): PostExportItem {
  return { fileBase, source: src, crop: createCrop(), params: { photo: createAdjust() }, jpeg: true, cube: false, ...patch };
}

async function run(dir: string, posts: PostExportItem[], grid: GridExportItem | null = null): Promise<IndexerResponse[]> {
  await mkdir(dir, { recursive: true });
  const messages: IndexerResponse[] = [];
  await runExport({ type: 'export', jobId: 'job', dir, cardFile: null, luts: [], posts, grid, plan: null }, (m) => messages.push(m));
  return messages;
}

async function pixels(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Средний цвет области (доли ширины и высоты). */
function mean(img: { data: Buffer; width: number; height: number }, [x0, x1]: [number, number], [y0, y1]: [number, number]): Rgb {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(y0 * img.height); y < Math.ceil(y1 * img.height); y++) {
    for (let x = Math.floor(x0 * img.width); x < Math.ceil(x1 * img.width); x++) {
      for (let c = 0; c < 3; c++) sum[c]! += img.data[(y * img.width + x) * 3 + c]!;
      n++;
    }
  }
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

const distance = (a: Rgb, b: Rgb) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
const through = (c: Rgb, params: Parameters<typeof applyPipeline>[1]): Rgb => {
  const [r, g, b] = applyPipeline([c.r / 255, c.g / 255, c.b / 255] as Rgb01, params).map((v) => v * 255);
  return { r: r!, g: g!, b: b! };
};

const STRIPES: Rgb[] = [
  { r: 200, g: 40, b: 40 },
  { r: 220, g: 200, b: 40 },
  { r: 40, g: 160, b: 60 },
  { r: 40, g: 170, b: 200 },
  { r: 50, g: 60, b: 200 },
];
const stripeOf = (c: Rgb) => {
  const d = STRIPES.map((s) => distance(s, c));
  return d.indexOf(Math.min(...d));
};

describe('пост из оригинала', () => {
  test('размер по пропорциям кадра, JPEG с sRGB без прореживания; цвет — конвейер core от оригинала', async () => {
    const color: Rgb = { r: 90, g: 110, b: 120 };
    const file = await writePixelFixture(photos, 'однотонное', 2400, 3200, () => color);
    const src = await source(file);
    const look = { ...createAdjust(), exposure: 1, temp: -30 };
    const params = postPipeline(createAdjust(), look);
    const dir = join(root, 'uniform');
    const messages = await run(dir, [
      post('1 — однотонное', src, { params }),
      post('2 — квадрат', src, { crop: { ...createCrop(), feed: { aspect: '1:1', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 } } }),
      post('3 — лента', src, { crop: { ...createCrop(), feed: { aspect: '4:5', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 } } }),
    ]);
    expect(messages.map((m) => (m.type === 'file' ? [m.file, m.ok, 'warnings' in m] : m.type))).toEqual([
      ['1 — однотонное.jpg', true, false],
      ['2 — квадрат.jpg', true, false],
      ['3 — лента.jpg', true, false],
      'done',
    ]);
    const sizes = [];
    for (const name of ['1 — однотонное.jpg', '2 — квадрат.jpg', '3 — лента.jpg']) {
      const meta = await sharp(join(dir, name)).metadata();
      expect([meta.format, meta.hasProfile, meta.chromaSubsampling]).toEqual(['jpeg', true, '4:4:4']);
      sizes.push([meta.width, meta.height]);
    }
    expect(sizes).toEqual([
      [1080, 1440],
      [1080, 1080],
      [1080, 1350],
    ]);
    // Оригинал так, как его читает прокси, через конвейер core — с точностью JPEG q95.
    const original = mean(await pixels(file), [0.4, 0.6], [0.4, 0.6]);
    const expected = through(original, params);
    const got = mean(await pixels(join(dir, '1 — однотонное.jpg')), [0.1, 0.9], [0.1, 0.9]);
    expect(distance(got, expected)).toBeLessThanOrEqual(2);
    expect(distance(got, original)).toBeGreaterThan(30);
  });

  test('кадр ленты: полосы сверху вниз те, что даёт feedFrameTransform, и с поворотом', async () => {
    const W = 1200;
    const H = 3000;
    const file = await writePixelFixture(photos, 'полосы', W, H, (_u, v) => STRIPES[Math.min(4, Math.floor(v * 5))]!);
    const src = await source(file);
    for (const angle of [0, 15]) {
      const crop: Crop = { feed: { aspect: '4:5', cx: 0.5, cy: 1, zoom: 1, angle }, grid: { cx: 0.5, cy: 0.5 } };
      const dir = join(root, `stripes-${angle}`);
      await run(dir, [post('полосы', src, { crop })]);
      const img = await pixels(join(dir, 'полосы.jpg'));
      expect([img.width, img.height]).toEqual([1080, 1350]);
      const transform = feedFrameTransform(W, H, crop);
      let checked = 0;
      for (let k = 0; k < 20; k++) {
        const v = (k + 0.5) / 20;
        const t = applyAffine(transform, 0.5, v)[1] * 5;
        // Точки у границы полос пропускаем: там цвет смешан.
        if (Math.abs(t - Math.round(t)) < 0.1) continue;
        expect(stripeOf(mean(img, [0.49, 0.51], [v - 0.005, v + 0.005])), `v = ${v}`).toBe(Math.floor(t));
        checked++;
      }
      expect(checked).toBeGreaterThan(10);
    }
    // По горизонтали пост — весь кадр ленты, а не окно сетки: синяя полоса фото x < 1200 видна слева.
    const blue: Rgb = { r: 40, g: 60, b: 200 };
    const yellow: Rgb = { r: 220, g: 200, b: 40 };
    const wide = await writePixelFixture(photos, 'альбомное', 4000, 3000, (u) => (u < 0.3 ? blue : yellow));
    const dir = join(root, 'wide');
    await run(dir, [post('квадрат', await source(wide), { crop: { ...createCrop(), feed: { aspect: '1:1', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 } } })]);
    const img = await pixels(join(dir, 'квадрат.jpg'));
    // Кадр 1:1 — x 500…3500: синее до (1200 − 500) / 3000 = 0.233 ширины поста.
    expect(distance(mean(img, [0.02, 0.2], [0.1, 0.9]), blue)).toBeLessThanOrEqual(2);
    expect(distance(mean(img, [0.27, 0.98], [0.1, 0.9]), yellow)).toBeLessThanOrEqual(2);
  });

  test('EXIF-поворот и Display P3 — как у прокси', async () => {
    const orange: Rgb = { r: 200, g: 100, b: 30 };
    const rotated = await writeFixture(photos, { name: 'поворот', width: 900, height: 1200, format: 'jpeg', color: orange, orientation: 6 });
    const p3 = await writeFixture(photos, { name: 'p3', width: 900, height: 1200, format: 'jpeg', color: orange, profile: 'p3' });
    const dir = join(root, 'orient');
    const messages = await run(dir, [post('поворот', await source(rotated)), post('p3', await source(p3))]);
    // Оригинал 900 × 1200 меньше поста 1080 × 1440: увеличен, отчёт предупреждает.
    expect(messages[0]).toMatchObject({ ok: true, warnings: ['оригинал меньше поста: увеличен в 1.2 раза'] });
    const img = await pixels(join(dir, 'поворот.jpg'));
    // Поворот уже в пикселях; EXIF оригинала (ориентация, GPS) в пост не переносится.
    const meta = await sharp(join(dir, 'поворот.jpg')).metadata();
    expect([meta.exif, meta.orientation, meta.width, meta.height]).toEqual([undefined, undefined, 1080, 1440]);
    expect(distance(mean(img, [0.01, 0.06], [0.01, 0.06]), MARKER)).toBeLessThanOrEqual(6);
    expect(distance(mean(img, [0.8, 0.95], [0.8, 0.95]), orange)).toBeLessThanOrEqual(3);
    expect(distance(mean(await pixels(join(dir, 'p3.jpg')), [0.5, 0.9], [0.5, 0.9]), orange)).toBeLessThanOrEqual(3);
  });

  test('пропавший или изменившийся оригинал — пост пропущен с причиной, остальные пишутся, оригиналы не меняются', async () => {
    const a = await writePixelFixture(photos, 'a', 600, 800, () => ({ r: 10, g: 20, b: 30 }));
    const b = await writePixelFixture(photos, 'b', 600, 800, () => ({ r: 40, g: 50, b: 60 }));
    const before = await readFile(a);
    const srcA = await source(a);
    const srcB = await source(b);
    const changed = { ...srcB, hash: '0'.repeat(64) };
    const missing = { path: join(photos, 'нет.jpg'), hash: srcA.hash };
    const dir = join(root, 'missing');
    const messages = await run(dir, [post('1 — нет', missing, { cube: true }), post('2 — b', changed), post('3 — a', srcA)]);
    expect(messages).toEqual([
      { type: 'file', jobId: 'job', file: '1 — нет.jpg', ok: false, error: `оригинал не найден: ${missing.path}` },
      { type: 'file', jobId: 'job', file: '1 — нет.cube', ok: true },
      { type: 'file', jobId: 'job', file: '2 — b.jpg', ok: false, error: `оригинал изменился после импорта: ${b}` },
      { type: 'file', jobId: 'job', file: '3 — a.jpg', ok: true, warnings: ['оригинал меньше поста: увеличен в 1.8 раза'] },
      { type: 'done', jobId: 'job' },
    ]);
    expect((await readdir(dir)).sort()).toEqual(['1 — нет.cube', '3 — a.jpg']);
    expect((await readFile(a)).equals(before)).toBe(true);
  });

  test('LUT на каждый пост — связка «поправка фото + образ», TITLE — имя поста, размер по проверке', async () => {
    const src = { path: join(photos, 'не нужен.jpg'), hash: '' };
    const params = postPipeline({ ...createAdjust(), exposure: 0.2 }, { ...createAdjust(), contrast: 30, temp: 15 });
    const kink = postPipeline(createAdjust(), {
      ...createAdjust(),
      curves: {
        master: [
          [0, 0],
          [0.45, 0.1],
          [0.55, 0.9],
          [1, 1],
        ],
        r: [
          [0, 0],
          [1, 1],
        ],
        g: [
          [0, 0],
          [1, 1],
        ],
        b: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    const dir = join(root, 'cube');
    const items = [post('1 — рампа', src, { params, jpeg: false, cube: true }), post('2 — излом', src, { params: kink, jpeg: false, cube: true })];
    expect(exportFiles({ cardFile: null, luts: [], posts: items, grid: null, plan: null })).toEqual(['1 — рампа.cube', '2 — излом.cube']);
    expect((await run(dir, items)).every((m) => m.type === 'done' || (m.type === 'file' && m.ok))).toBe(true);
    const text = await readFile(join(dir, '1 — рампа.cube'), 'utf8');
    expect(text).toMatch(/^# Gridtone — пост «1 — рампа»: поправка фото и образ/);
    expect(text).toContain('\nTITLE "1 — рампа"\nLUT_3D_SIZE 33\n');
    const cube = await readCube(join(dir, '1 — рампа.cube'));
    const expected = bakeLut(params, 33);
    for (let i = 0; i < cube.data.length; i++) expect(Math.abs(cube.data[i]! - expected.data[i]!)).toBeLessThanOrEqual(5e-7 + 1e-12);
    expect(await readFile(join(dir, '2 — излом.cube'), 'utf8')).toContain('\nLUT_3D_SIZE 65\n');
  });
});

describe('сетка', () => {
  test('раскладка 3 колонки, плитка 540 × 720, окна сетки; позиция без фото — серая', async () => {
    const red = await writePixelFixture(photos, 'красное', 1500, 2000, () => ({ r: 200, g: 40, b: 40 }));
    // Слева синяя полоса до x = 1200, дальше жёлтое. Кадр 1:1 — x 500…3500; окно 3:4 у его правого края —
    // x 1250…3500, в плитке только жёлтое. Окно по центру (875…3125) захватило бы синее.
    const halves = await writePixelFixture(photos, 'половины', 4000, 3000, (u) => (u < 0.3 ? { r: 40, g: 60, b: 200 } : { r: 220, g: 200, b: 40 }));
    const square: Crop = { feed: { aspect: '1:1', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 }, grid: { cx: 1, cy: 0.5 } };
    const look = { ...createAdjust(), exposure: 0.5 };
    const tile = async (file: string, patch: Partial<GridTileItem> = {}): Promise<GridTileItem> => ({
      label: 'плитка',
      source: await source(file),
      fallback: join(root, 'нет превью.jpg'),
      crop: createCrop(),
      params: { photo: createAdjust() },
      ...patch,
    });
    const grid: GridExportItem = {
      file: 'Сетка.png',
      ratio: '3:4',
      columns: 3,
      tiles: [await tile(red, { params: postPipeline(createAdjust(), look) }), null, await tile(halves, { crop: square }), await tile(red)],
    };
    const dir = join(root, 'grid');
    expect(await run(dir, [], grid)).toEqual([
      { type: 'file', jobId: 'job', file: 'Сетка.png', ok: true },
      { type: 'done', jobId: 'job' },
    ]);
    const meta = await sharp(join(dir, 'Сетка.png')).metadata();
    const layout = gridLayout(4, '3:4', 3);
    expect([meta.format, meta.width, meta.height, meta.channels, meta.depth, meta.hasProfile]).toEqual([
      'png',
      layout.width,
      layout.height,
      3,
      'uchar',
      true,
    ]);
    const img = await pixels(join(dir, 'Сетка.png'));
    const cell = (i: number) => {
      const [x, y] = layout.cells[i]!;
      const crop = { width: layout.tileWidth, height: layout.tileHeight };
      return (fx: [number, number], fy: [number, number]) =>
        mean(img, [(x + fx[0] * crop.width) / img.width, (x + fx[1] * crop.width) / img.width], [
          (y + fy[0] * crop.height) / img.height,
          (y + fy[1] * crop.height) / img.height,
        ]);
    };
    const all: [number, number] = [0.02, 0.98];
    expect(distance(cell(0)(all, all), through({ r: 200, g: 40, b: 40 }, postPipeline(createAdjust(), look)))).toBeLessThanOrEqual(2);
    expect(distance(cell(1)(all, all), { r: GRID_EMPTY[0], g: GRID_EMPTY[1], b: GRID_EMPTY[2] })).toBe(0);
    expect(distance(cell(2)(all, all), { r: 220, g: 200, b: 40 })).toBeLessThanOrEqual(2);
    expect(distance(cell(3)(all, all), { r: 200, g: 40, b: 40 })).toBeLessThanOrEqual(2);
    // Промежуток между плитками — фон.
    const [gx] = layout.cells[1]!;
    const gap = mean(img, [(gx - 2) / img.width, (gx - 1) / img.width], [0.1, 0.2]);
    expect(distance(gap, { r: GRID_BACKGROUND[0], g: GRID_BACKGROUND[1], b: GRID_BACKGROUND[2] })).toBe(0);
  });

  test('оригинала нет — плитка из прокси 2048 с оговоркой; нет и прокси — позиция пустая', async () => {
    const color = { r: 60, g: 140, b: 90 };
    const file = await writePixelFixture(photos, 'зелёное', 900, 1200, () => color);
    const proxy = join(root, 'proxy-2048.jpg');
    await writeFile(proxy, await renderProxy(file, 2048));
    const moved = join(root, 'moved.jpg');
    await copyFile(file, moved);
    const src = await source(moved);
    await rm(moved);
    const tile = (fallback: string, label: string): GridTileItem => ({
      label,
      source: src,
      fallback,
      crop: createCrop(),
      params: { photo: createAdjust() },
    });
    const dir = join(root, 'grid-fallback');
    const messages = await run(dir, [], {
      file: 'Сетка.png',
      ratio: '1:1',
      columns: 3,
      tiles: [tile(proxy, 'плитка 1 (зелёное)'), tile(join(root, 'нет.jpg'), 'плитка 2 (зелёное)')],
    });
    expect(messages[0]).toEqual({
      type: 'file',
      jobId: 'job',
      file: 'Сетка.png',
      ok: true,
      warnings: [
        `плитка 1 (зелёное): оригинал не найден: ${moved} — плитка из превью 2048`,
        `плитка 2 (зелёное): оригинал не найден: ${moved}, превью тоже нет — позиция пустая`,
      ],
    });
    const img = await pixels(join(dir, 'Сетка.png'));
    const layout = gridLayout(2, '1:1', 3);
    expect([img.width, img.height]).toEqual([layout.width, 540]);
    const at = (i: number) => mean(img, [(layout.cells[i]![0] + 20) / img.width, (layout.cells[i]![0] + 520) / img.width], [0.05, 0.95]);
    expect(distance(at(0), color)).toBeLessThanOrEqual(2);
    expect(distance(at(1), { r: GRID_EMPTY[0], g: GRID_EMPTY[1], b: GRID_EMPTY[2] })).toBe(0);
  });
});
