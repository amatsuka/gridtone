// Состав сетки и статусы из renderer (docs/decisions/0022-statuses-empty-pinned.md). Пустые позиции — будущие
// посты: вставляются в начало ленты, сразу после закреплённых, и удаляются; статус «опубликован» ставится и
// снимается у позиций с фото. Фото в позицию ставит и из неё убирает только main. Функции порядка возвращают
// новый массив из тех же объектов слотов; в черновик Immer его пишет assignSlots.
import { createSlot } from './defaults';
import type { Project, Slot } from './types';

/** Позиция без фото: место под план или подбор. Коррекции, кадра и образа у неё нет (ADR 0022). */
export function isEmptySlot(slot: Pick<Slot, 'assetId'>): boolean {
  return slot.assetId === undefined;
}

/** Закреплённые — первые grid.pinned позиций; если слотов меньше, закреплены все. */
export function isPinnedIndex(index: number, pinned: number): boolean {
  return index < pinned;
}

/**
 * Пустые позиции с id ids — в начало ленты, сразу после закреплённых: новый пост встаёт туда же
 * (spec, «Устойчивость к сдвигу»). Остальные позиции, опубликованные тоже, сдвигаются дальше.
 */
export function insertEmptySlots(slots: readonly Slot[], ids: readonly string[], pinned: number): Slot[] {
  const at = Math.min(Math.max(0, pinned), slots.length);
  return [...slots.slice(0, at), ...ids.map((id) => createSlot(id)), ...slots.slice(at)];
}

/** Удаляет пустые позиции из ids; позиции с фото и неизвестные id не трогаются. */
export function removeEmptySlots(slots: readonly Slot[], ids: Iterable<string>): Slot[] {
  const drop = new Set(ids);
  return slots.filter((slot) => !(drop.has(slot.id) && isEmptySlot(slot)));
}

/**
 * Статус «опубликован» у позиций с фото из ids: published — «опубликован», иначе «запланирован». Пустые
 * позиции не меняются. Меняет проект на месте — в renderer это черновик Immer.
 */
export function setPublished(project: Pick<Project, 'slots'>, ids: Iterable<string>, published: boolean): void {
  const targets = new Set(ids);
  const state = published ? 'published' : 'planned';
  for (const slot of project.slots) {
    if (targets.has(slot.id) && !isEmptySlot(slot) && slot.state !== state) slot.state = state;
  }
}

/**
 * Пишет новый порядок слотов в черновик: только изменившиеся позиции, новые — в хвост, лишние — обрезкой
 * длины. Патчи Immer тогда — replace изменившихся индексов и add или remove в хвосте, а не замена массива:
 * отмена остаётся верной и после импорта, который дописывает слоты в конец (ADR 0011, 0022).
 */
export function assignSlots(draft: Slot[], base: readonly Slot[], next: readonly Slot[]): void {
  next.forEach((slot, i) => {
    if (slot !== base[i]) draft[i] = slot;
  });
  if (draft.length > next.length) draft.length = next.length;
}
