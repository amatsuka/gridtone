import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bakeLut, lookPipeline } from '@core/lut/bake';
import { CARD_HEIGHT, CARD_LIMITS, CARD_WIDTH, renderCard, type CardReport } from '@core/lut/calibration';
import { createAdjust } from '@core/project/defaults';
import type { IndexerResponse } from '@shared/ipc';
import { cardPng, checkCardFile, runCardCheck } from '../../src/indexer/calibration';
import { brighten, editRgb, readRgb, toSharp, viaLut, type RawImage } from '../fixtures/editor';
import { filmLook } from '../golden/looks';

let root: string;
let cardFile: string;
let card: RawImage;

const film = lookPipeline(filmLook());
const filmLut = viaLut(bakeLut(film, 33));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-card-'));
  cardFile = join(root, 'Калибровка.png');
  await writeFile(cardFile, await cardPng());
  card = await readRgb(cardFile);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function verdict(report: CardReport): string {
  return report.verdict;
}

function lutMean(report: CardReport): number {
  if (report.verdict === 'geometry') throw new Error('геометрия');
  return report.models.lut.mean;
}

describe('калибровочная карта в utility process', () => {
  test('PNG: 1800 × 768, RGB 8 бит, профиль sRGB внутри, точки — как в core', async () => {
    const meta = await sharp(cardFile).metadata();
    expect([meta.format, meta.width, meta.height, meta.channels, meta.depth, meta.hasProfile]).toEqual([
      'png',
      CARD_WIDTH,
      CARD_HEIGHT,
      3,
      'uchar',
      true,
    ]);
    // Сырые значения из файла, без перевода по профилю: в файле ровно то, что нарисовал core.
    const { data } = await sharp(cardFile).keepIccProfile().raw().toBuffer({ resolveWithObject: true });
    const rgba = renderCard().data;
    let differ = 0;
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      if (data[i] !== rgba[j] || data[i + 1] !== rgba[j + 1] || data[i + 2] !== rgba[j + 2]) differ++;
    }
    expect(differ).toBe(0);
    expect(Buffer.compare(card.data, data)).toBe(0);
  });

  test('карта, вернувшаяся без LUT, — «LUT не применён»; с LUT, уменьшенная вдвое, JPEG q90 — «совпадает»', async () => {
    expect(verdict(await checkCardFile(cardFile, film))).toBe('no-lut');
    const file = join(root, 'плёнка.jpg');
    await toSharp(editRgb(card, filmLut))
      .resize(CARD_WIDTH / 2, CARD_HEIGHT / 2)
      .withIccProfile('srgb')
      .jpeg({ quality: 90 })
      .toFile(file);
    const report = await checkCardFile(file, film);
    expect(verdict(report)).toBe('match');
    expect(lutMean(report)).toBeLessThan(CARD_LIMITS.mean);
    expect(report).toMatchObject({ width: CARD_WIDTH / 2, height: CARD_HEIGHT / 2 });
  });

  test('Display P3 переводится в sRGB по профилю, как у прокси; без перевода карта бы не совпала', async () => {
    const file = join(root, 'p3.png');
    await toSharp(editRgb(card, filmLut)).withIccProfile('p3').png().toFile(file);
    // Тест не пустой: сырые P3-значения дают «не совпадает».
    const raw = await sharp(file).keepIccProfile().raw().toBuffer({ resolveWithObject: true });
    const rawFile = join(root, 'p3-как-srgb.png');
    await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 3 } }).png().toFile(rawFile);
    expect(verdict(await checkCardFile(rawFile, film))).not.toBe('match');

    expect(verdict(await checkCardFile(file, film))).toBe('match');
  });

  test('16 бит, EXIF-поворот, прозрачность и карта крупнее исходной читаются тем же рецептом', async () => {
    const edited = editRgb(card, filmLut);
    const png16 = join(root, '16.png');
    await toSharp(edited).toColourspace('rgb16').png().toFile(png16);
    expect(verdict(await checkCardFile(png16, film))).toBe('match');

    // В файле точки повёрнуты, тег 6 возвращает их как надо.
    const rotated = join(root, 'rotated.jpg');
    await sharp(await toSharp(edited).rotate(270).png().toBuffer())
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toFile(rotated);
    expect(verdict(await checkCardFile(rotated, film))).toBe('match');

    const alpha = join(root, 'alpha.png');
    await toSharp(edited).ensureAlpha(1).png().toFile(alpha);
    expect(verdict(await checkCardFile(alpha, film))).toBe('match');

    const large = join(root, 'large.jpg');
    await toSharp(edited).resize(CARD_WIDTH * 2, CARD_HEIGHT * 2).jpeg({ quality: 92 }).toFile(large);
    const report = await checkCardFile(large, film);
    expect(verdict(report)).toBe('match');
    expect(report).toMatchObject({ width: CARD_WIDTH, height: CARD_HEIGHT });
  });

  test('осветлённая до LUT карта — «сдвинут»; обрезанная — без замера', async () => {
    const lift = brighten(0.3);
    const shifted = join(root, 'shifted.jpg');
    await toSharp(editRgb(card, (c) => filmLut(lift(c)))).jpeg({ quality: 90 }).toFile(shifted);
    expect(verdict(await checkCardFile(shifted, film))).toBe('shifted');

    const cropped = join(root, 'cropped.jpg');
    await toSharp(editRgb(card, filmLut))
      .extract({ left: 0, top: 0, width: CARD_WIDTH - 200, height: CARD_HEIGHT })
      .jpeg()
      .toFile(cropped);
    expect(await checkCardFile(cropped, film)).toEqual({ verdict: 'geometry', problem: 'proportions', width: CARD_WIDTH - 200, height: CARD_HEIGHT });
  });

  test('не картинка — ошибка задачи с причиной', async () => {
    const broken = join(root, 'broken.jpg');
    await writeFile(broken, 'это не jpeg');
    await expect(checkCardFile(broken, film)).rejects.toThrow(/не удалось прочитать изображение/);
    const messages: IndexerResponse[] = [];
    await runCardCheck({ type: 'check-card', jobId: 'job', path: broken, params: film }, (m) => messages.push(m));
    expect(messages).toEqual([{ type: 'card', jobId: 'job', ok: false, error: expect.stringMatching(/не удалось прочитать/) }]);
    const ok: IndexerResponse[] = [];
    await runCardCheck({ type: 'check-card', jobId: 'job', path: cardFile, params: lookPipeline(createAdjust()) }, (m) => ok.push(m));
    expect(ok).toMatchObject([{ type: 'card', jobId: 'job', ok: true, report: { verdict: 'match', weak: true } }]);
  });
});
