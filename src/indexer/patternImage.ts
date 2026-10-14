// Картинка-шаблон паттерна в utility process (docs/decisions/0024-pattern-image.md): чтение тем же рецептом цвета,
// что у прокси, возвращённой карты и оригиналов для экспорта (decodeSrgb, ADR 0004 и 0016), уменьшение до
// PATTERN_IMAGE_MAX_SIDE по длинной стороне, RGBA 8 бит. Сетку ищет и цели считает core/pattern/image.ts в renderer.
import { PATTERN_IMAGE_MAX_SIDE } from '@core/pattern/image';
import type { DecodeImageJob, IndexerResponse, PatternImage } from '@shared/ipc';
import { decodeSrgb, errorMessage } from './proxies';

/**
 * Пиксели картинки: EXIF-поворот, перевод по ICC в sRGB, прозрачность — на белый, как у прокси. Крупная картинка
 * уменьшается sharp (fit inside), мелкая не увеличивается. Не картинка — ошибка «не удалось прочитать изображение».
 */
export async function decodePatternImage(path: string): Promise<PatternImage> {
  try {
    const { data, info } = await decodeSrgb(path)
      .resize({ width: PATTERN_IMAGE_MAX_SIDE, height: PATTERN_IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`${info.channels} канала вместо 4`);
    return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch (err) {
    throw new Error(`не удалось прочитать изображение (${errorMessage(err)})`);
  }
}

/** Задача чтения: один ответ 'image' с пикселями или ошибкой. */
export async function runDecodeImage(job: DecodeImageJob, post: (message: IndexerResponse) => void): Promise<void> {
  try {
    post({ type: 'image', jobId: job.jobId, ok: true, image: await decodePatternImage(job.path) });
  } catch (err) {
    post({ type: 'image', jobId: job.jobId, ok: false, error: errorMessage(err) });
  }
}
