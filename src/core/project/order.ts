// Порядок слотов в сетке: перестановка выделения. Опубликованные посты и закреплённые позиции (первые
// grid.pinned) стоят на своих местах, остальные слоты обтекают их (docs/spec.md, «Статусы позиций»;
// docs/decisions/0022-statuses-empty-pinned.md). Одна плитка на пустой позиции меняется с ней местами.
// Функции возвращают новый массив из тех же объектов слотов.
import { isEmptySlot } from './slots';
import type { Slot } from './types';

const movable = (slot: Slot, index: number, pinned: number) => index >= pinned && slot.state !== 'published';

/**
 * Перетаскивание: выделенные слоты собираются в блок в прежнем порядке, и первый из них встаёт
 * на позицию to (индекс в сетке). Блок не выходит за конец сетки. Одна плитка, отпущенная на пустую
 * позицию, меняется с ней местами.
 */
export function moveSlots(slots: readonly Slot[], ids: Iterable<string>, to: number, pinned: number): Slot[] {
  const selected = new Set(ids);
  const picked = slots.flatMap((slot, i) => (selected.has(slot.id) && movable(slot, i, pinned) ? [i] : []));
  const target = slots[to];
  if (picked.length === 1 && target && movable(target, to, pinned) && isEmptySlot(target) && picked[0] !== to) {
    return swap(slots, picked[0] as number, to);
  }
  // Позиция в сетке → позиция среди подвижных слотов.
  const freeTo = slots.slice(0, Math.max(0, to)).filter((slot, i) => movable(slot, i, pinned)).length;
  return rearrange(slots, pinned, (free) => {
    const block = free.filter((slot) => selected.has(slot.id));
    const rest = free.filter((slot) => !selected.has(slot.id));
    const at = Math.min(freeTo, rest.length);
    return [...rest.slice(0, at), ...block, ...rest.slice(at)];
  });
}

/**
 * Сдвиг с клавиатуры: выделенные слоты сдвигаются на delta позиций вместе, промежутки между
 * ними сохраняются. У края сдвиг укорачивается так, чтобы ни один слот не вышел за сетку.
 * Одна плитка, сдвинутая на пустую позицию, меняется с ней местами.
 */
export function shiftSlots(slots: readonly Slot[], ids: Iterable<string>, delta: number, pinned: number): Slot[] {
  const selected = new Set(ids);
  return rearrange(slots, pinned, (free) => {
    const picked = free.flatMap((slot, i) => (selected.has(slot.id) ? [i] : []));
    const first = picked[0];
    const last = picked.at(-1);
    if (first === undefined || last === undefined) return free;
    const d = Math.max(-first, Math.min(delta, free.length - 1 - last));
    if (d === 0) return free;
    const target = free[first + d] as Slot;
    if (picked.length === 1 && isEmptySlot(target)) return swap(free, first, first + d);
    const result = free.map((): Slot | undefined => undefined);
    for (const i of picked) result[i + d] = free[i];
    const others = free.filter((slot) => !selected.has(slot.id));
    let k = 0;
    return result.map((slot) => slot ?? (others[k++] as Slot));
  });
}

function swap(slots: readonly Slot[], a: number, b: number): Slot[] {
  const result = [...slots];
  result[a] = slots[b] as Slot;
  result[b] = slots[a] as Slot;
  return result;
}

/** Переставляет только подвижные слоты; опубликованные и закреплённые остаются на своих индексах. */
function rearrange(slots: readonly Slot[], pinned: number, arrange: (free: Slot[]) => Slot[]): Slot[] {
  const arranged = arrange(slots.filter((slot, i) => movable(slot, i, pinned)));
  let k = 0;
  return slots.map((slot, i) => (movable(slot, i, pinned) ? (arranged[k++] as Slot) : slot));
}
