import { describe, expect, test } from 'vitest';
import { clickSelection, EMPTY_SELECTION, pruneSelection, selectAll, type Selection } from '../../src/renderer/selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

function click(sel: Selection, id: string, mode: 'replace' | 'toggle' | 'range' = 'replace'): Selection {
  return clickSelection(sel, ORDER, id, mode);
}

describe('выделение плиток', () => {
  test('клик выделяет одну плитку, она основная', () => {
    expect(click(EMPTY_SELECTION, 'c')).toEqual({ ids: ['c'], primary: 'c', anchor: 'c' });
  });

  test('⌘-клик добавляет и снимает; основная — последняя кликнутая', () => {
    let sel = click(EMPTY_SELECTION, 'a');
    sel = click(sel, 'c', 'toggle');
    sel = click(sel, 'e', 'toggle');
    expect(sel).toEqual({ ids: ['a', 'c', 'e'], primary: 'e', anchor: 'e' });

    sel = click(sel, 'e', 'toggle');
    expect(sel).toEqual({ ids: ['a', 'c'], primary: 'c', anchor: 'e' });
    sel = click(sel, 'a', 'toggle');
    expect(sel.primary).toBe('c');
    sel = click(sel, 'c', 'toggle');
    expect(sel).toEqual({ ids: [], primary: null, anchor: 'c' });
  });

  test('Shift-клик выделяет диапазон от якоря в обе стороны', () => {
    let sel = click(EMPTY_SELECTION, 'b');
    sel = click(sel, 'd', 'range');
    expect(sel).toEqual({ ids: ['b', 'c', 'd'], primary: 'd', anchor: 'b' });
    sel = click(sel, 'a', 'range');
    expect(sel).toEqual({ ids: ['a', 'b'], primary: 'a', anchor: 'b' });
  });

  test('Shift-клик без якоря — обычный клик', () => {
    expect(click(EMPTY_SELECTION, 'd', 'range')).toEqual({ ids: ['d'], primary: 'd', anchor: 'd' });
  });

  test('⌘A выделяет все, основная сохраняется', () => {
    expect(selectAll(click(EMPTY_SELECTION, 'c'), ORDER)).toEqual({ ids: ORDER, primary: 'c', anchor: 'c' });
    expect(selectAll(EMPTY_SELECTION, ORDER)).toEqual({ ids: ORDER, primary: 'a', anchor: 'a' });
  });

  test('пропавшие плитки выпадают из выделения', () => {
    const sel: Selection = { ids: ['a', 'c', 'x'], primary: 'x', anchor: 'x' };
    expect(pruneSelection(sel, ORDER)).toEqual({ ids: ['a', 'c'], primary: 'c', anchor: null });
    const same = click(EMPTY_SELECTION, 'b');
    expect(pruneSelection(same, ORDER)).toBe(same);
  });
});
