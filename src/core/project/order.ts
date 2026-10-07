// Порядок слотов в сетке: перестановка выделения. Опубликованные посты стоят на своих позициях,
// остальные слоты обтекают их (docs/spec.md, «Статусы позиций»). Функции возвращают новый массив
// из тех же объектов слотов.
import type { Slot } from './types';

const movable = (slot: Slot) => slot.state !== 'published';

/**
 * Перетаскивание: выделенные слоты собираются в блок в прежнем порядке, и первый из них встаёт
 * на позицию to (индекс в сетке). Блок не выходит за конец сетки.
 */
export function moveSlots(slots: readonly Slot[], ids: Iterable<string>, to: number): Slot[] {
  const selected = new Set(ids);
  // Позиция в сетке → позиция среди подвижных слотов.
  const freeTo = slots.slice(0, Math.max(0, to)).filter(movable).length;
  return rearrange(slots, (free) => {
    const block = free.filter((slot) => selected.has(slot.id));
    const rest = free.filter((slot) => !selected.has(slot.id));
    const at = Math.min(freeTo, rest.length);
    return [...rest.slice(0, at), ...block, ...rest.slice(at)];
  });
}

/**
 * Сдвиг с клавиатуры: выделенные слоты сдвигаются на delta позиций вместе, промежутки между
 * ними сохраняются. У края сдвиг укорачивается так, чтобы ни один слот не вышел за сетку.
 */
export function shiftSlots(slots: readonly Slot[], ids: Iterable<string>, delta: number): Slot[] {
  const selected = new Set(ids);
  return rearrange(slots, (free) => {
    const picked = free.flatMap((slot, i) => (selected.has(slot.id) ? [i] : []));
    const first = picked[0];
    const last = picked.at(-1);
    if (first === undefined || last === undefined) return free;
    const d = Math.max(-first, Math.min(delta, free.length - 1 - last));
    if (d === 0) return free;
    const result = free.map((): Slot | undefined => undefined);
    for (const i of picked) result[i + d] = free[i];
    const others = free.filter((slot) => !selected.has(slot.id));
    let k = 0;
    return result.map((slot) => slot ?? (others[k++] as Slot));
  });
}

/** Переставляет только подвижные слоты; опубликованные остаются на своих индексах. */
function rearrange(slots: readonly Slot[], arrange: (free: Slot[]) => Slot[]): Slot[] {
  const arranged = arrange(slots.filter(movable));
  let k = 0;
  return slots.map((slot) => (movable(slot) ? (arranged[k++] as Slot) : slot));
}
