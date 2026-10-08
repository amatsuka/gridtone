import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import type { ImageFormat } from '@core/project/types';
import { PROXY_SIZES, proxyRelPath, type ProxySize } from '@shared/cache';
import type { IndexErrorCode, IndexItem, IndexedAsset } from '@shared/ipc';
import { hashFile } from './hash';

// Память на 8 ГБ: без кэша операций libvips и с ограниченным числом потоков на картинку.
sharp.cache(false);
sharp.concurrency(2);

export class IndexError extends Error {
  constructor(
    readonly code: IndexErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const FORMATS: Partial<Record<string, ImageFormat>> = { jpeg: 'jpeg', png: 'png', webp: 'webp', tiff: 'tiff' };

/** inside — длинная сторона = размер (редактор видит весь кадр); outside — короткая сторона = размер (окно 3:4 в плитке). */
const PROXY_FIT: Record<ProxySize, 'inside' | 'outside'> = { 2048: 'inside', 512: 'outside' };

/**
 * Хэширует оригинал и строит недостающие прокси в cache/.
 * Прокси пишутся через временный файл и rename: под итоговым именем всегда лежит целый файл.
 */
export async function indexFile(item: IndexItem, cacheDir: string): Promise<IndexedAsset> {
  const hash = await hashFile(item.path);
  if (item.expectHash !== undefined && hash !== item.expectHash) {
    throw new IndexError('hash-mismatch', 'Оригинал изменился после импорта');
  }
  const id = hash.slice(0, 16);

  const meta = await sharp(item.path, { failOn: 'error' })
    .metadata()
    .catch((err: unknown) => {
      throw new IndexError('unsupported', `Не удалось прочитать изображение: ${errorMessage(err)}`);
    });
  const format = FORMATS[meta.format];
  if (!format) {
    const name = meta.format === 'heif' ? 'HEIC/HEIF' : meta.format.toUpperCase();
    throw new IndexError('unsupported', `${name} пока не поддерживается`);
  }

  for (const size of PROXY_SIZES) {
    const file = join(cacheDir, proxyRelPath(id, size));
    if (await exists(file)) continue;
    const data = await renderProxy(item.path, size);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  return {
    id,
    path: item.path,
    hash,
    w: meta.autoOrient.width,
    h: meta.autoOrient.height,
    format,
    icc: meta.hasProfile ? 'embedded' : 'assumed-srgb',
  };
}

/**
 * Рецепт цвета прокси без уменьшения: EXIF-поворот и перевод в sRGB по встроенному ICC.
 * pipelineColourspace('srgb') обязателен: без него 16-битные файлы получают неверный цвет
 * (docs/decisions/0004-proxies.md). Им же читаются возвращённая калибровочная карта и оригиналы
 * для экспорта постов (ADR 0016, 0017). Конвейер sharp при этом 8-битный: 16 бит входа сводятся к 8.
 */
export function decodeSrgb(src: string | Buffer): Sharp {
  return sharp(src, { failOn: 'error' }).autoOrient().pipelineColourspace('srgb');
}

/** Прокси в sRGB со вшитым профилем. */
export function renderProxy(src: string, size: ProxySize): Promise<Buffer> {
  return decodeSrgb(src)
    .resize({ width: size, height: size, fit: PROXY_FIT[size], withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .withIccProfile('srgb')
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
