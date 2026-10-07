// Сообщения renderer ↔ воркеры метрик (docs/decisions/0012-view-modes.md) и проверки LUT. Внутри renderer, не IPC Electron.
import type { PipelineParams } from '@core/color/bake';
import type { LutSizeChoice } from '@core/lut/verify';
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

/** Проверка по кругу для диалога экспорта (docs/decisions/0014-lut-export.md). key — коррекция образа в JSON. */
export interface LutCheckRequest {
  key: string;
  params: PipelineParams;
}

export type LutCheckResponse = { key: string; ok: true; choice: LutSizeChoice } | { key: string; ok: false; error: string };
