// Экспорт постов и сетки (docs/spec.md, «Модуль 1», «Экспорт»; docs/decisions/0017-post-export.md):
// порядок публикации, имена файлов, размеры постов, раскладка сетки и предуменьшение оригинала.
// Пиксели считает core/image/render.ts, файлы пишет utility process.
import { safeFileName, uniqueNames } from './fileNames';
import type { Crop, Ratio, Slot } from './types';

/** Ширина поста в ленте; высота — по пропорциям кадра ленты. */
export const POST_WIDTH = 1080;
const POST_HEIGHT: Record<Crop['feed']['aspect'], number> = { '4:5': 1350, '3:4': 1440, '1:1': 1080 };

/** Плитка в `Сетка.png`: половина ширины поста, как плитка профиля на телефоне с плотностью 3. */
export const GRID_TILE_WIDTH = 540;
/** Промежуток между плитками: около 1 pt профиля Instagram при плитке 540 px. */
export const GRID_GAP = 4;
/** Фон промежутков — белый, как профиль в светлой теме. */
export const GRID_BACKGROUND: readonly [number, number, number] = [255, 255, 255];
/** Позиция без фото в сетке — светло-серая. */
export const GRID_EMPTY: readonly [number, number, number] = [239, 239, 239];

/** Оригинал предуменьшается до PRESCALE точек на точку выхода: дальше выборка по матрице усредняет 2 × 2. */
export const PRESCALE = 2;
/** Если оригинал меньше выхода больше чем на 1%, отчёт предупреждает об увеличении. */
export const UPSCALE_WARN_BELOW = 0.99;

const GRID_HEIGHT: Record<Ratio, number> = { '3:4': 720, '1:1': 540 };

export function postSize(aspect: Crop['feed']['aspect']): [number, number] {
  return [POST_WIDTH, POST_HEIGHT[aspect]];
}

/**
 * Индексы слотов в порядке публикации. Сетка — снизу вверх: новый пост встаёт в левый верхний угол,
 * поэтому последняя плитка публикуется первой. Опубликованные и пустые позиции пропускаются.
 */
export function publishOrder(slots: readonly Slot[]): number[] {
  const order: number[] = [];
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i] as Slot;
    if (slot.state === 'planned' && slot.assetId !== undefined) order.push(i);
  }
  return order;
}

/**
 * Имена файлов постов без расширения: «1 — рампа» — номер в порядке публикации и имя оригинала.
 * Номера одной ширины (01…12), чтобы Finder сортировал их по порядку. reserved — имена, уже занятые
 * в подпапке экспорта (карта, сетка, LUT образов): совпавшее получит номер.
 */
export function postFileBases(stems: readonly string[], reserved: readonly string[] = []): string[] {
  const width = String(stems.length).length;
  const bases = stems.map((stem, i) => `${String(i + 1).padStart(width, '0')} — ${safeFileName(stem, 'фото')}`);
  return uniqueNames([...reserved, ...bases]).slice(reserved.length);
}

export interface GridLayout {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Левый верхний угол каждой плитки по порядку сетки. */
  cells: [number, number][];
}

/** `Сетка.png`: columns колонок плиток 540 px в пропорциях сетки, промежутки GRID_GAP. */
export function gridLayout(count: number, ratio: Ratio, columns: number): GridLayout {
  const tileWidth = GRID_TILE_WIDTH;
  const tileHeight = GRID_HEIGHT[ratio];
  const rows = Math.ceil(count / columns);
  const cells = Array.from({ length: count }, (_, i): [number, number] => [
    (i % columns) * (tileWidth + GRID_GAP),
    Math.floor(i / columns) * (tileHeight + GRID_GAP),
  ]);
  return {
    width: columns * tileWidth + (columns - 1) * GRID_GAP,
    height: Math.max(0, rows * tileHeight + (rows - 1) * GRID_GAP),
    tileWidth,
    tileHeight,
    cells,
  };
}

/**
 * Размер, до которого sharp уменьшает оригинал перед выборкой: scale — масштаб окна (windowScale),
 * точек оригинала на точку выхода. null — оригинал и так не больше PRESCALE точек на точку, он не трогается.
 */
export function prescaleSize(width: number, height: number, scale: number): [number, number] | null {
  if (scale <= PRESCALE) return null;
  const k = PRESCALE / scale;
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}
