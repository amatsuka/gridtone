import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { proxyRelPath, type ProxySize } from '@shared/cache';
import { IndexError, indexFile } from '../../src/indexer/proxies';
import { MARKER, writeFixture, type FixtureSpec, type Rgb } from '../fixtures/generate';

let root: string;
let photos: string;
let cache: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-indexer-'));
  photos = join(root, 'photos');
  cache = join(root, 'cache');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ORANGE: Rgb = { r: 200, g: 100, b: 30 };

function spec(overrides: Partial<FixtureSpec> & Pick<FixtureSpec, 'name'>): FixtureSpec {
  return { width: 600, height: 800, format: 'jpeg', color: ORANGE, ...overrides };
}

async function index(overrides: Partial<FixtureSpec> & Pick<FixtureSpec, 'name'>) {
  const file = await writeFixture(photos, spec(overrides));
  const asset = await indexFile({ path: file }, cache);
  const proxy = (size: ProxySize) => join(cache, proxyRelPath(asset.id, size));
  return { file, asset, proxy };
}

async function size(file: string) {
  const { width, height } = await sharp(file).metadata();
  return [width, height];
}

/** Цвет пикселя; keepIcc — сырые значения из файла, без перевода по профилю. */
async function pixel(file: string, x: number, y: number, keepIcc = false): Promise<Rgb> {
  const image = keepIcc ? sharp(file).keepIccProfile() : sharp(file);
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = x < 0 ? info.width + x : x;
  const py = y < 0 ? info.height + y : y;
  const i = (py * info.width + px) * info.channels;
  return { r: data[i] ?? -1, g: data[i + 1] ?? -1, b: data[i + 2] ?? -1 };
}

function distance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

describe('размеры прокси', () => {
  test('2048 — по длинной стороне, 512 — по короткой', async () => {
    const portrait = await index({ name: 'portrait', width: 3024, height: 4032 });
    expect(await size(portrait.proxy(2048))).toEqual([1536, 2048]);
    expect(await size(portrait.proxy(512))).toEqual([512, 683]);

    const landscape = await index({ name: 'landscape', width: 4032, height: 3024 });
    expect(await size(landscape.proxy(2048))).toEqual([2048, 1536]);
    expect(await size(landscape.proxy(512))).toEqual([683, 512]);
  });

  test('маленькие фото не увеличиваются', async () => {
    const small = await index({ name: 'small', width: 400, height: 500 });
    expect(await size(small.proxy(2048))).toEqual([400, 500]);
    expect(await size(small.proxy(512))).toEqual([400, 500]);
    expect([small.asset.w, small.asset.h]).toEqual([400, 500]);
  });
});

describe('ориентация', () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])('EXIF-ориентация %i', async (orientation) => {
    const { asset, proxy } = await index({ name: `orient-${orientation}`, width: 900, height: 600, orientation });
    expect([asset.w, asset.h]).toEqual([900, 600]);
    expect(await size(proxy(512))).toEqual([768, 512]);
    expect(distance(await pixel(proxy(512), 4, 4), MARKER)).toBeLessThanOrEqual(4);
    expect(distance(await pixel(proxy(512), -4, -4), ORANGE)).toBeLessThanOrEqual(4);
  });
});

describe('цвет', () => {
  test('Display P3 переводится в sRGB по встроенному профилю', async () => {
    const { file, asset, proxy } = await index({ name: 'p3', profile: 'p3' });
    // Проверка, что тест вообще способен заметить ошибку: сырые P3-значения заметно отличаются от sRGB.
    expect(distance(await pixel(file, -4, -4, true), ORANGE)).toBeGreaterThan(10);

    expect(asset.icc).toBe('embedded');
    for (const size of [512, 2048] as const) {
      expect(distance(await pixel(proxy(size), -4, -4), ORANGE)).toBeLessThanOrEqual(3);
      expect((await sharp(proxy(size)).metadata()).hasProfile).toBe(true);
    }
  });

  test('16-битный PNG без профиля даёт правильный цвет', async () => {
    const { asset, proxy } = await index({ name: 'png16', format: 'png', bits16: true });
    expect(asset.format).toBe('png');
    expect(asset.icc).toBe('assumed-srgb');
    expect(distance(await pixel(proxy(512), -4, -4), ORANGE)).toBeLessThanOrEqual(3);
  });

  test('16-битный PNG с профилем P3', async () => {
    const { proxy } = await index({ name: 'png16-p3', format: 'png', bits16: true, profile: 'p3' });
    expect(distance(await pixel(proxy(512), -4, -4), ORANGE)).toBeLessThanOrEqual(3);
  });

  test.each(['webp', 'tiff'] as const)('%s с профилем P3', async (format) => {
    const { asset, proxy } = await index({ name: `p3-${format}`, format, profile: 'p3' });
    expect(asset.format).toBe(format);
    expect(distance(await pixel(proxy(512), -4, -4), ORANGE)).toBeLessThanOrEqual(3);
  });

  test('прозрачность ложится на белый', async () => {
    const { proxy } = await index({ name: 'alpha', format: 'png', alpha: true });
    expect(distance(await pixel(proxy(512), -4, -4), { r: 255, g: 255, b: 255 })).toBeLessThanOrEqual(2);
    expect(distance(await pixel(proxy(512), 4, 4), MARKER)).toBeLessThanOrEqual(4);
  });
});

describe('идентичность и кэш', () => {
  test('id — начало SHA-256 содержимого, hash — полный', async () => {
    const { file, asset } = await index({ name: 'hash' });
    const expected = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    expect(asset.hash).toBe(expected);
    expect(asset.id).toBe(expected.slice(0, 16));
  });

  test('повторная индексация не переписывает готовые прокси', async () => {
    const { file, proxy } = await index({ name: 'again' });
    const before = (await stat(proxy(2048))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexFile({ path: file }, cache);
    expect((await stat(proxy(2048))).mtimeMs).toBe(before);
  });

  test('одинаковые фото в одном импорте индексируются параллельно без гонки за прокси', async () => {
    // Два файла с одним содержимым строят один и тот же прокси одновременно: раньше общий .tmp
    // переименовывал один из них из-под другого, и второй падал с ENOENT.
    const file = await writeFixture(photos, spec({ name: 'twin-a', color: { r: 30, g: 140, b: 150 } }));
    const twin = join(photos, 'twin-b.jpg');
    await writeFile(twin, await readFile(file));
    const assets = await Promise.all([file, twin, file, twin].map((path) => indexFile({ path }, cache)));
    expect(new Set(assets.map((asset) => asset.id)).size).toBe(1);
    const proxy = join(cache, proxyRelPath(assets[0]!.id, 512));
    expect(await size(proxy)).toEqual([512, 683]);
  });

  test('изменившийся оригинал не пересобирается', async () => {
    const file = await writeFixture(photos, spec({ name: 'changed' }));
    const err = await indexFile({ path: file, expectHash: '0'.repeat(64) }, cache).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexError);
    expect((err as IndexError).code).toBe('hash-mismatch');
  });

  test.each([
    ['GIF', 'anim.gif', () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).gif().toBuffer()],
    ['не картинка', 'fake.jpg', async () => Buffer.from('это не jpeg')],
  ])('%s отклоняется как неподдерживаемый', async (_, name, make) => {
    const file = join(root, name);
    await writeFile(file, await make());
    const err = await indexFile({ path: file }, cache).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexError);
    expect((err as IndexError).code).toBe('unsupported');
  });
});
