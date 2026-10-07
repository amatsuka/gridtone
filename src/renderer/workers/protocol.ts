// Сообщения renderer ↔ воркер метрик (docs/decisions/0012-view-modes.md). Внутри renderer, не IPC Electron.
import type { PipelineParams } from '@core/color/bake';
import type { TileMetrics } from '@core/metrics/tile';
import type { Crop, Ratio } from '@core/project/types';

export interface MetricsRequest {
  /** Ключ кэша: ассет, сетка, кадр и параметры конвейера. Ответ приходит с тем же ключом. */
  key: string;
  assetId: string;
  /** gridtone://proxy/<assetId>/512 */
  url: string;
  crop: Crop;
  ratio: Ratio;
  params: PipelineParams;
}

export type MetricsResponse = { key: string; ok: true; metrics: TileMetrics } | { key: string; ok: false; error: string };
