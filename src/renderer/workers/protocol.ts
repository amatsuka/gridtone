// Сообщения renderer ↔ воркеры метрик (docs/decisions/0012-view-modes.md) и проверки LUT. Внутри renderer, не IPC Electron.
import type { PipelineParams } from '@core/color/bake';
import type { FixTarget, TileFix } from '@core/harmony/fixes';
import type { Lut3D } from '@core/lut/lut3d';
import type { LutSizeChoice } from '@core/lut/verify';
import type { TileMetrics } from '@core/metrics/tile';
import type { Crop, Ratio } from '@core/project/types';

/**
 * LUT образа для воркера (docs/decisions/0015-lut-import.md): присылается один раз на id, до первого
 * запроса с ним. В запросах дальше — только id: таблица 65³ весит 6.6 МБ.
 */
export interface WorkerLut {
  type: 'lut';
  id: string;
  lut: Lut3D;
}

export interface MetricsRequest {
  type: 'tile';
  /** Ключ кэша: ассет, сетка, кадр, параметры конвейера и id LUT. Ответ приходит с тем же ключом. */
  key: string;
  assetId: string;
  /** gridtone://proxy/<assetId>/512 */
  url: string;
  crop: Crop;
  ratio: Ratio;
  /** Без LUT: его воркер берёт из присланных по lutId. */
  params: PipelineParams;
  lutId?: string;
}

/**
 * Поправка выброса (docs/decisions/0021-fixes.md): тот же прокси, окно и конвейер, что у метрик плитки, и что
 * чинить. key — ключ метрик слота и цель поправки: ответ приходит с ним же.
 */
export interface FixRequest extends Omit<MetricsRequest, 'type'> {
  type: 'fix';
  target: FixTarget;
}

export type MetricsMessage = WorkerLut | MetricsRequest | FixRequest;

export type MetricsResponse =
  | { type: 'tile'; key: string; ok: true; metrics: TileMetrics }
  | { type: 'fix'; key: string; ok: true; fix: TileFix }
  | { type: 'tile' | 'fix'; key: string; ok: false; error: string };

/** Проверка по кругу для диалога экспорта (docs/decisions/0014-lut-export.md). key — коррекция образа и id LUT в JSON. */
export interface LutCheckRequest {
  type: 'check';
  key: string;
  /** Без LUT: его воркер берёт из присланных по lutId. */
  params: PipelineParams;
  lutId?: string;
}

export type LutCheckMessage = WorkerLut | LutCheckRequest;

export type LutCheckResponse = { key: string; ok: true; choice: LutSizeChoice } | { key: string; ok: false; error: string };
