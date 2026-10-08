// Калибровочная карта в utility process (docs/decisions/0016-calibration-card.md): запись PNG и проверка
// карты, которую вернул редактор. Раскладка, замер и диагноз — в core/lut/calibration.ts.
import sharp from 'sharp';
import type { PipelineParams } from '@core/color/bake';
import { CARD_HEIGHT, CARD_WIDTH, cardGeometry, checkCard, renderCard, type CardReport } from '@core/lut/calibration';
import type { CardCheckJob, IndexerResponse } from '@shared/ipc';
import { decodeSrgb, errorMessage } from './proxies';

/**
 * PNG карты: RGB 8 бит со вшитым sRGB. В отличие от HaldCLUT, в пикселях карты — цвета: редактор
 * должен понимать их как sRGB, как базовую версию фото.
 */
export function cardPng(): Promise<Buffer> {
  const card = renderCard();
  return sharp(card.data, { raw: { width: card.width, height: card.height, channels: 4 } })
    .removeAlpha()
    .withIccProfile('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Возвращённая карта → отчёт. Картинка читается рецептом цвета прокси (decodeSrgb: EXIF-поворот,
 * ICC → sRGB), прозрачность ложится на белый, как у прокси. Если пропорции не те, пиксели не
 * декодируются. Карта крупнее исходной уменьшается до её размера — так ограничена память; меньшую
 * замер в core переносит пропорционально, без пересчёта точек.
 */
export async function checkCardFile(path: string, params: PipelineParams): Promise<CardReport> {
  const meta = await sharp(path, { failOn: 'error' })
    .metadata()
    .catch((err: unknown) => {
      throw new Error(`не удалось прочитать изображение (${errorMessage(err)})`);
    });
  const { width, height } = meta.autoOrient;
  const geometry = cardGeometry(width, height);
  if (!geometry.ok) return { verdict: 'geometry', problem: geometry.problem, width, height };
  let image = decodeSrgb(path);
  if (width > CARD_WIDTH) image = image.resize({ width: CARD_WIDTH, height: CARD_HEIGHT, fit: 'fill' });
  const { data, info } = await image
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return checkCard({ width: info.width, height: info.height, channels: info.channels, data }, params);
}

/** Задача проверки: один ответ 'card' с отчётом или ошибкой. */
export async function runCardCheck(job: CardCheckJob, post: (message: IndexerResponse) => void): Promise<void> {
  try {
    post({ type: 'card', jobId: job.jobId, ok: true, report: await checkCardFile(job.path, job.params) });
  } catch (err) {
    post({ type: 'card', jobId: job.jobId, ok: false, error: errorMessage(err) });
  }
}
