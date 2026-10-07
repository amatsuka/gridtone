// Выделение плиток. Состояние интерфейса: в проект и в историю не попадает (ADR 0011).

export interface Selection {
  ids: readonly string[];
  /** Основная плитка — последняя кликнутая. Её правят ползунки, с неё копируются правки. */
  primary: string | null;
  /** Откуда Shift-клик отсчитывает диапазон. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], primary: null, anchor: null };

/** replace — клик, toggle — ⌘-клик, range — Shift-клик. order — id слотов в порядке сетки. */
export function clickSelection(
  selection: Selection,
  order: readonly string[],
  id: string,
  mode: 'replace' | 'toggle' | 'range',
): Selection {
  if (mode === 'toggle') {
    if (!selection.ids.includes(id)) return { ids: [...selection.ids, id], primary: id, anchor: id };
    const ids = selection.ids.filter((other) => other !== id);
    const primary = selection.primary === id ? (ids.at(-1) ?? null) : selection.primary;
    return { ids, primary, anchor: id };
  }

  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (mode === 'range' && from >= 0 && to >= 0) {
    return { ids: order.slice(Math.min(from, to), Math.max(from, to) + 1), primary: id, anchor: selection.anchor };
  }
  return { ids: [id], primary: id, anchor: id };
}

/** ⌘A: все плитки; основная остаётся, если была. */
export function selectAll(selection: Selection, order: readonly string[]): Selection {
  const primary = selection.primary ?? order[0] ?? null;
  return { ids: [...order], primary, anchor: selection.anchor ?? primary };
}

/** Убирает из выделения плитки, которых больше нет. Если ничего не пропало — тот же объект. */
export function pruneSelection(selection: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  const ids = selection.ids.filter((id) => present.has(id));
  const primaryOk = selection.primary === null || present.has(selection.primary);
  const anchorOk = selection.anchor === null || present.has(selection.anchor);
  if (ids.length === selection.ids.length && primaryOk && anchorOk) return selection;
  return {
    ids,
    primary: primaryOk ? selection.primary : (ids.at(-1) ?? null),
    anchor: anchorOk ? selection.anchor : null,
  };
}
