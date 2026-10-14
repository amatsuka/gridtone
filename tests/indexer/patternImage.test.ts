import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PATTERN_IMAGE_MAX_SIDE } from '@core/pattern/image';
import type { IndexerResponse, PatternImage } from '@shared/ipc';
import { decodePatternImage, runDecodeImage } from '../../src/indexer/patternImage';
import { MARKER, writeFixture, type FixtureSpec, type Rgb } from '../fixtures/generate';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-pattern-image-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TEAL: Rgb = { r: 40, g: 150, b: 140 };

function spec(overrides: Partial<FixtureSpec> & Pick<FixtureSpec, 'name'>): FixtureSpec {
  return { width: 600, height: 800, format: 'png', color: TEAL, ...overrides };
}

function at(image: PatternImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i] ?? -1, image.data[i + 1] ?? -1, image.data[i + 2] ?? -1, image.data[i + 3] ?? -1];
}

function near([r, g, b]: number[], color: Rgb, tolerance: number): boolean {
  return Math.max(Math.abs((r as number) - color.r), Math.abs((g as number) - color.g), Math.abs((b as number) - color.b)) <= tolerance;
}

describe('картинка-шаблон паттерна в utility process', () => {
  test('RGBA 8 бит, альфа 255; маленькая картинка не увеличивается, пиксели PNG — как в файле', async () => {
    const file = await writeFixture(root, spec({ name: 'small' }));
    const image = await decodePatternImage(file);
    expect([image.width, image.height, image.data.length]).toEqual([600, 800, 600 * 800 * 4]);
    expect(image.data).toBeInstanceOf(Uint8Array);
    const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(Buffer.compare(Buffer.from(image.data), data)).toBe(0);
    expect(at(image, 0, 0)).toEqual([MARKER.r, MARKER.g, MARKER.b, 255]);
  });

  test(`крупная уменьшается до ${PATTERN_IMAGE_MAX_SIDE} px по длинной стороне`, async () => {
    const portrait = await decodePatternImage(await writeFixture(root, spec({ name: 'portrait', width: 2400, height: 3200, format: 'jpeg' })));
    expect([portrait.width, portrait.height]).toEqual([1200, 1600]);
    const landscape = await decodePatternImage(await writeFixture(root, spec({ name: 'landscape', width: 3200, height: 1000, format: 'jpeg' })));
    expect([landscape.width, landscape.height]).toEqual([1600, 500]);
    expect(near(at(landscape, 1500, 400), TEAL, 3)).toBe(true);
  });

  test('рецепт цвета прокси: EXIF-поворот, Display P3 → sRGB, 16 бит, прозрачность — на белый', async () => {
    const rotated = await decodePatternImage(await writeFixture(root, spec({ name: 'rotated', format: 'jpeg', orientation: 6 })));
    expect([rotated.width, rotated.height]).toEqual([600, 800]);
    expect(near(at(rotated, 5, 5), MARKER, 40)).toBe(true);
    const p3 = await decodePatternImage(await writeFixture(root, spec({ name: 'p3', profile: 'p3' })));
    expect(near(at(p3, 300, 400), TEAL, 2)).toBe(true);
    const deep = await decodePatternImage(await writeFixture(root, spec({ name: 'deep', bits16: true })));
    expect(near(at(deep, 300, 400), TEAL, 1)).toBe(true);
    const alpha = await decodePatternImage(await writeFixture(root, spec({ name: 'alpha', alpha: true })));
    expect(at(alpha, 300, 400)).toEqual([255, 255, 255, 255]);
  });

  test('не картинка — ошибка с причиной; задача отвечает одним сообщением', async () => {
    const text = join(root, 'not-image.png');
    await writeFile(text, 'это не картинка');
    await expect(decodePatternImage(text)).rejects.toThrow(/не удалось прочитать изображение/);
    const messages: IndexerResponse[] = [];
    await runDecodeImage({ type: 'decode-image', jobId: 'bad', path: text }, (m) => messages.push(m));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'image', jobId: 'bad', ok: false });
    const good = await writeFixture(root, spec({ name: 'good', width: 30, height: 40 }));
    await runDecodeImage({ type: 'decode-image', jobId: 'ok', path: good }, (m) => messages.push(m));
    expect(messages[1]).toMatchObject({ type: 'image', jobId: 'ok', ok: true, image: { width: 30, height: 40 } });
  });
});
