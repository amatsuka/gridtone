// Экспорт постов и сетки (docs/spec.md, «Модуль 1», «Экспорт»; docs/decisions/0017-post-export.md):
// порядок публикации, имена файлов, размеры постов, раскладка сетки и предуменьшение оригинала.
// Порядок публикации и номера постов — только planOrder (docs/decisions/0022-statuses-empty-pinned.md):
// по нему нумеруют плитки, экспорт и план контента. Пиксели считает core/image/render.ts, файлы пишет
// utility process.
import { safeFileName, uniqueNames } from './fileNames';
import { isEmptySlot } from './slots';
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

/** Позиция плана публикации: запланированный пост или пустая позиция. */
export interface PlanEntry {
  /** Номер в порядке публикации, с 1. */
  number: number;
  /** Позиция в сетке. */
  index: number;
  slotId: string;
  /** Есть фото — пост; нет — пустая позиция: номер у неё есть, файла нет. */
  photo: boolean;
  /** Закреплённая позиция: пост публикуется последним и закрепляется. */
  pin: boolean;
  /** В ленте ниже опубликованного: на этом месте пост не опубликовать — новые встают в начало ленты. */
  belowPublished: boolean;
}

/**
 * План публикации (ADR 0022). Сетка — снизу вверх: новый пост встаёт в начало ленты, сразу после закреплённых,
 * поэтому последняя позиция публикуется первой. В план входят запланированные посты и пустые позиции, опубликованные
 * пропускаются. Закреплённые (первые pinned позиций) — вне ленты: идут последними, тоже снизу вверх, с «закрепить».
 */
export function planOrder(slots: readonly Slot[], pinned: number): PlanEntry[] {
  const first = Math.min(Math.max(0, pinned), slots.length);
  const entries: PlanEntry[] = [];
  const add = (index: number, pin: boolean, belowPublished: boolean) => {
    const slot = slots[index] as Slot;
    if (slot.state === 'published') return;
    entries.push({ number: entries.length + 1, index, slotId: slot.id, photo: !isEmptySlot(slot), pin, belowPublished });
  };
  // Опубликованный выше в ленте: позиция с меньшим индексом, не закреплённая.
  const firstPublished = slots.findIndex((slot, i) => i >= first && slot.state === 'published');
  for (let i = slots.length - 1; i >= first; i--) add(i, false, firstPublished >= 0 && firstPublished < i);
  for (let i = first - 1; i >= 0; i--) add(i, true, false);
  return entries;
}

/** Индексы постов с фото в порядке публикации — то, что экспортируется файлами. */
export function publishOrder(slots: readonly Slot[], pinned: number): number[] {
  return planOrder(slots, pinned)
    .filter((entry) => entry.photo)
    .map((entry) => entry.index);
}

/** «1», «1, 2», «1–3, 5»: подряд от трёх номеров — диапазоном. */
export function formatNumbers(numbers: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && (numbers[j + 1] as number) === (numbers[j] as number) + 1) j++;
    if (j - i >= 2) parts.push(`${numbers[i]}–${numbers[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(numbers[k]));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Оговорки плана для диалога и отчёта экспорта: пустые позиции — номер есть, файла нет; пост ниже опубликованного
 * на своём месте не опубликовать.
 */
export function planNotes(entries: readonly PlanEntry[]): string[] {
  const notes: string[] = [];
  const empty = entries.filter((entry) => !entry.photo).map((entry) => entry.number);
  if (empty.length === 1) notes.push(`Пост ${empty[0]} — пустая позиция: номер пропущен, файла нет.`);
  else if (empty.length > 1) notes.push(`Посты ${formatNumbers(empty)} — пустые позиции: номера пропущены, файлов нет.`);
  const below = belowPublishedNote(entries);
  if (below) notes.push(below);
  return notes;
}

/** «Пост 4 ниже опубликованного…» — для экспорта постов и плана контента; null — таких позиций нет. */
export function belowPublishedNote(entries: readonly Pick<PlanEntry, 'number' | 'belowPublished'>[]): string | null {
  const below = entries.filter((entry) => entry.belowPublished).map((entry) => entry.number);
  if (below.length === 1) return `Пост ${below[0]} ниже опубликованного: на этом месте его не опубликовать.`;
  if (below.length > 1) return `Посты ${formatNumbers(below)} ниже опубликованного: на этих местах их не опубликовать.`;
  return null;
}

/** Пост для имени файла: номер в плане, имя оригинала, закреплять ли. */
export interface PostName {
  number: number;
  stem: string;
  pin: boolean;
}

/**
 * Имена файлов постов без расширения: «1 — рампа» — номер в плане публикации и имя оригинала; у закреплённого —
 * «9 — рампа (закрепить)». Номера одной ширины по числу позиций плана total (01…12), чтобы Finder сортировал их
 * по порядку; у пустых позиций номера пропущены. reserved — имена, уже занятые в подпапке экспорта (карта, сетка,
 * LUT образов): совпавшее получит номер.
 */
export function postFileBases(posts: readonly PostName[], total: number, reserved: readonly string[] = []): string[] {
  const width = String(total).length;
  const bases = posts.map(
    ({ number, stem, pin }) => `${String(number).padStart(width, '0')} — ${safeFileName(stem, 'фото')}${pin ? ' (закрепить)' : ''}`,
  );
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
