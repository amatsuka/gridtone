// Воркер метрик для режимов 5 и 7 и вкладки «Анализ» (docs/decisions/0012-view-modes.md, 0018-features-grid-metrics.md):
// прокси 512 → окно сетки → конвейер core → OKLab → признаки плитки и доминанта. Сам расчёт — tileMetrics
// из core; здесь только декодирование и очередь. Анализ сетки по готовым признакам — в renderer.
// Поправки выбросов (ADR 0021) — findFix из core по тому же окну; их считает второй экземпляр воркера.
import { findFix, searchWindow } from '@core/harmony/fixes';
import type { RgbaImage } from '@core/image/sample';
import { tileMetrics, windowRgb } from '@core/metrics/tile';
import type { Lut3D } from '@core/lut/lut3d';
import type { FixRequest, MetricsMessage, MetricsRequest, MetricsResponse } from './protocol';

/** Декодированных прокси в памяти: по 512 × 683 × 4 ≈ 1.4 МБ. */
const MAX_IMAGES = 24;
const images = new Map<string, Promise<RgbaImage>>();
/** LUT образов по id: присылаются один раз, id выводится из содержимого. */
const luts = new Map<string, Lut3D>();

async function decode(url: string): Promise<RgbaImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Прокси уже в sRGB (ADR 0004): как и для текстур, без пересчёта цвета.
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D-контекст недоступен');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

/** Прокси по ассету, LRU: недавно нужный уходит в конец. */
function proxy(assetId: string, url: string): Promise<RgbaImage> {
  const cached = images.get(assetId);
  images.delete(assetId);
  const entry = cached ?? decode(url);
  images.set(assetId, entry);
  entry.catch(() => images.delete(assetId));
  for (const id of images.keys()) {
    if (images.size <= MAX_IMAGES) break;
    images.delete(id);
  }
  return entry;
}

async function handle(request: MetricsRequest | FixRequest): Promise<MetricsResponse> {
  try {
    const image = await proxy(request.assetId, request.url);
    const lut = request.lutId === undefined ? undefined : luts.get(request.lutId);
    if (request.lutId !== undefined && !lut) throw new Error(`LUT ${request.lutId} не прислан`);
    const params = lut ? { ...request.params, lut } : request.params;
    if (request.type === 'fix') {
      const window = searchWindow(windowRgb(image, request.crop, request.ratio), request.ratio);
      return { type: 'fix', key: request.key, ok: true, fix: findFix(window, params, request.target) };
    }
    return { type: 'tile', key: request.key, ok: true, metrics: tileMetrics(image, request.crop, request.ratio, params) };
  } catch (err) {
    return { type: request.type, key: request.key, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// По одной плитке за раз: ответы идут по мере готовности, и воркер не держит в памяти все окна сразу.
let queue = Promise.resolve();
self.addEventListener('message', (event: MessageEvent<MetricsMessage>) => {
  const message = event.data;
  if (message.type === 'lut') {
    luts.set(message.id, message.lut);
    return;
  }
  queue = queue.then(async () => self.postMessage(await handle(message)));
});
