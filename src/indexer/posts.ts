// Посты и сетка в utility process (docs/decisions/0017-post-export.md). Оригинал читается целиком и
// сверяется по хэшу, декодируется рецептом прокси (decodeSrgb, ADR 0004) с предуменьшением sharp до
// двух точек на точку выхода; окно по матрице crop.ts и конвейер core — core/image/render.ts.
// Оригинал только читается: файлы экспорта пишет export.ts в новую подпапку с флагом wx.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renderWindow } from '@core/image/render';
import { windowScale, type RgbaImage } from '@core/image/sample';
import { bakeLut } from '@core/lut/bake';
import { postCubeComments, writeCube } from '@core/lut/cube';
import { chooseLutSize } from '@core/lut/verify';
import { feedFrameTransform, gridWindowTransform, type Affine } from '@core/project/crop';
import { GRID_BACKGROUND, GRID_EMPTY, UPSCALE_WARN_BELOW, gridLayout, postSize, prescaleSize } from '@core/project/publish';
import type { Ratio } from '@core/project/types';
import type { ExportSource, GridExportItem, GridTileItem, PostExportItem } from '@shared/ipc';
import { decodeSrgb, errorMessage } from './proxies';

/** Содержимое файла и оговорки к нему для отчёта. */
export interface Rendered {
  data: Buffer;
  warnings: string[];
}

/** JPEG поста: q95 без прореживания цветности, как прокси (ADR 0004), со вшитым sRGB. */
const POST_JPEG = { quality: 95, chromaSubsampling: '4:4:4' } as const;

/**
 * Оригинал целиком: из этих же байтов считается хэш и декодируется картинка, так что между проверкой
 * и чтением файл не подменится. Изменившийся оригинал не экспортируется: кадр строился по другому фото.
 */
export async function readOriginal(source: ExportSource): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(source.path);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(missing ? `оригинал не найден: ${source.path}` : `оригинал не читается: ${errorMessage(err)}`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== source.hash) {
    throw new Error(`оригинал изменился после импорта: ${source.path}`);
  }
  return bytes;
}

interface SourceWindow {
  image: RgbaImage;
  /** Окно в нормированных координатах: одинаково для оригинала и его уменьшенной копии. */
  transform: Affine;
  /** Точек оригинала на точку выхода; меньше 1 — оригинал увеличивается. */
  scale: number;
}

/**
 * Картинка для окна width × height: размеры после EXIF-поворота → матрица окна → предуменьшение sharp
 * до двух точек на точку выхода (prescaleSize) → RGB 8 бит. Прозрачность ложится на белый, как у прокси.
 */
async function loadWindow(
  input: string | Buffer,
  transformFor: (width: number, height: number) => Affine,
  width: number,
  height: number,
): Promise<SourceWindow> {
  const meta = await sharp(input, { failOn: 'error' })
    .metadata()
    .catch((err: unknown) => {
      throw new Error(`не удалось прочитать изображение (${errorMessage(err)})`);
    });
  const { width: w, height: h } = meta.autoOrient;
  const transform = transformFor(w, h);
  const scale = windowScale(transform, w, h, width, height);
  const shrink = prescaleSize(w, h, scale);
  let image = decodeSrgb(input);
  if (shrink) image = image.resize({ width: shrink[0], height: shrink[1], fit: 'fill' });
  const { data, info } = await image
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`неожиданное число каналов: ${info.channels}`);
  return { image: { width: info.width, height: info.height, data, channels: 3 }, transform, scale };
}

function upscaleWarnings(scale: number, what: string): string[] {
  return scale < UPSCALE_WARN_BELOW ? [`оригинал меньше ${what}: увеличен в ${(1 / scale).toFixed(1)} раза`] : [];
}

/** Пост: оригинал по кадру ленты, 1080 × 1350 / 1440 / 1080, конвейер core, JPEG с sRGB. */
export async function postJpeg(item: PostExportItem): Promise<Rendered> {
  const [width, height] = postSize(item.crop.feed.aspect);
  const bytes = await readOriginal(item.source);
  const window = await loadWindow(bytes, (w, h) => feedFrameTransform(w, h, item.crop), width, height);
  const pixels = renderWindow(window.image, window.transform, width, height, item.params);
  const data = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .jpeg(POST_JPEG)
    .toBuffer();
  return { data, warnings: upscaleWarnings(window.scale, 'поста') };
}

/**
 * LUT на каждый пост: связка «поправка фото + образ» с LUT образа, `.cube` 33 или 65 по проверке
 * по кругу, как LUT образа (ADR 0014). Оригинал для него не нужен.
 */
export function postCube(item: PostExportItem): Rendered {
  const choice = chooseLutSize(item.params);
  const text = writeCube(bakeLut(item.params, choice.size, item.fileBase), postCubeComments(item.fileBase));
  const check = choice.checks[choice.size];
  const warnings = check?.pass
    ? []
    : [`проверка по кругу не пройдена и на ${choice.size}: ΔE2000 ср. ${check?.tetrahedral.mean.toFixed(2)}, 99% ${check?.tetrahedral.p99.toFixed(2)}`];
  return { data: Buffer.from(text, 'utf8'), warnings };
}

/**
 * Плитка сетки: окно сетки из оригинала. Если оригинал пропал или изменился, плитка берётся из прокси
 * 2048 — сетка остаётся целой, отчёт об этом говорит; если нет и прокси — позиция пустая.
 */
async function gridTile(
  tile: GridTileItem,
  ratio: Ratio,
  width: number,
  height: number,
  warnings: string[],
): Promise<Uint8Array | null> {
  const transformFor = (w: number, h: number) => gridWindowTransform(w, h, tile.crop, ratio);
  let window: SourceWindow;
  try {
    window = await loadWindow(await readOriginal(tile.source), transformFor, width, height);
    warnings.push(...upscaleWarnings(window.scale, 'плитки').map((w) => `${tile.label}: ${w}`));
  } catch (err) {
    try {
      window = await loadWindow(tile.fallback, transformFor, width, height);
      warnings.push(`${tile.label}: ${errorMessage(err)} — плитка из превью 2048`);
    } catch {
      warnings.push(`${tile.label}: ${errorMessage(err)}, превью тоже нет — позиция пустая`);
      return null;
    }
  }
  return renderWindow(window.image, window.transform, width, height, tile.params);
}

/** `Сетка.png`: окна сетки всех позиций в раскладке gridLayout, RGB 8 бит со вшитым sRGB. */
export async function gridPng(item: GridExportItem): Promise<Rendered> {
  const layout = gridLayout(item.tiles.length, item.ratio, item.columns);
  if (layout.cells.length === 0) throw new Error('в сетке нет позиций');
  const { width, height, tileWidth, tileHeight } = layout;
  const canvas = Buffer.alloc(width * height * 3);
  fill(canvas, 0, width * height, GRID_BACKGROUND);
  const warnings: string[] = [];
  for (const [i, tile] of item.tiles.entries()) {
    const [x, y] = layout.cells[i] as [number, number];
    const pixels = tile ? await gridTile(tile, item.ratio, tileWidth, tileHeight, warnings) : null;
    for (let row = 0; row < tileHeight; row++) {
      const offset = (y + row) * width + x;
      if (pixels) canvas.set(pixels.subarray(row * tileWidth * 3, (row + 1) * tileWidth * 3), offset * 3);
      else fill(canvas, offset, tileWidth, GRID_EMPTY);
    }
  }
  const data = await sharp(canvas, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { data, warnings };
}

/** count точек подряд с точки start заливаются цветом. */
function fill(canvas: Buffer, start: number, count: number, [r, g, b]: readonly [number, number, number]): void {
  for (let i = start * 3, end = (start + count) * 3; i < end; i += 3) {
    canvas[i] = r;
    canvas[i + 1] = g;
    canvas[i + 2] = b;
  }
}
