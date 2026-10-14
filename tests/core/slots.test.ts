// Состав сетки из renderer (ADR 0022): пустые позиции, статус «опубликован», запись порядка в черновик.
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { describe, expect, test } from 'vitest';
import { createProject, createSlot } from '@core/project/defaults';
import { applyProjectPatches, type ProjectPatch } from '@core/project/patch';
import { assignSlots, insertEmptySlots, isEmptySlot, removeEmptySlots, setPublished } from '@core/project/slots';
import type { Project, Slot } from '@core/project/types';

enablePatches();

const ASSET = 'aaaaaaaaaaaaaaaa';

function photos(...ids: string[]): Slot[] {
  return ids.map((id) => createSlot(id, ASSET));
}

function project(slots: Slot[], pinned: Project['grid']['pinned'] = 0): Project {
  const p = createProject('p');
  p.assets[ASSET] = {
    id: ASSET,
    path: '/ph/a.jpg',
    hash: 'a'.repeat(64),
    w: 3000,
    h: 4000,
    format: 'jpeg',
    icc: 'embedded',
    importedAt: '2026-10-14T00:00:00.000Z',
  };
  p.slots = slots;
  p.grid.pinned = pinned;
  return p;
}

const ids = (slots: readonly Slot[]) => slots.map((slot) => slot.id);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('пустые позиции', () => {
  test('вставляются в начало ленты — после закреплённых; слоты те же объекты', () => {
    const slots = photos('a', 'b', 'c', 'd');
    const inserted = insertEmptySlots(slots, ['e1', 'e2', 'e3'], 1);
    expect(ids(inserted)).toEqual(['a', 'e1', 'e2', 'e3', 'b', 'c', 'd']);
    expect(inserted[1]).toEqual(createSlot('e1'));
    expect(inserted.filter(isEmptySlot).map((s) => s.state)).toEqual(['empty', 'empty', 'empty']);
    expect(inserted[0]).toBe(slots[0]);
    expect(inserted[4]).toBe(slots[1]);
    expect(ids(insertEmptySlots(slots, ['e'], 0))).toEqual(['e', 'a', 'b', 'c', 'd']);
    // Закреплённых больше, чем слотов, — в конец.
    expect(ids(insertEmptySlots(photos('a'), ['e'], 3))).toEqual(['a', 'e']);
  });

  test('удаляются только пустые; фото и неизвестные id не мешают', () => {
    const slots = insertEmptySlots(photos('a', 'b'), ['e1', 'e2'], 0);
    expect(ids(removeEmptySlots(slots, ['e2', 'a', 'zz']))).toEqual(['e1', 'a', 'b']);
    expect(ids(removeEmptySlots(slots, []))).toEqual(ids(slots));
  });
});

describe('статус «опубликован»', () => {
  test('ставится и снимается у позиций с фото; пустые не трогаются', () => {
    const p = project([...photos('a', 'b'), createSlot('e')]);
    setPublished(p, ['a', 'e'], true);
    expect(p.slots.map((s) => s.state)).toEqual(['published', 'planned', 'empty']);
    setPublished(p, ['a', 'b', 'e'], false);
    expect(p.slots.map((s) => s.state)).toEqual(['planned', 'planned', 'empty']);
  });

  test('через Immer: одна правка — патчи только изменившихся статусов, main их принимает', () => {
    const base = project(photos('a', 'b', 'c'));
    const [next, patches, inverse] = produceWithPatches(base, (draft) => setPublished(draft, ['b', 'c'], true));
    expect(patches.map((p) => p.path.join('.')).sort()).toEqual(['slots.1.state', 'slots.2.state']);
    const main = clone(base);
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(main).toEqual(next);
    applyProjectPatches(main, inverse as ProjectPatch[]);
    expect(main).toEqual(base);
  });
});

/**
 * renderer: правка через assignSlots, как в commands.ts; main применяет те же патчи и дописывает импорт в конец.
 * Отмена и повтор после импорта обязаны дать тот же состав, что и без него, плюс импортированные в конце.
 */
describe('assignSlots: патчи вставки и удаления переживают импорт в конец (ADR 0011, 0022)', () => {
  function edit(base: Project, arrange: (slots: readonly Slot[]) => Slot[]): { next: Project; patches: Patch[]; inverse: Patch[] } {
    const [next, patches, inverse] = produceWithPatches(base, (draft) => assignSlots(draft.slots, base.slots, arrange(base.slots)));
    return { next, patches, inverse };
  }

  /** Импорт main: фото в конец. */
  function importPhoto(p: Project, id: string): void {
    p.slots.push(createSlot(id, ASSET));
  }

  test('вставка ряда пустых: replace изменившихся и add в хвосте; отмена и повтор после импорта', () => {
    const base = project(photos('a', 'b', 'c', 'd', 'e'), 1);
    const { next, patches, inverse } = edit(base, (slots) => insertEmptySlots(slots, ['x', 'y', 'z'], 1));
    expect(ids(next.slots)).toEqual(['a', 'x', 'y', 'z', 'b', 'c', 'd', 'e']);
    expect(patches.every((p) => (p.op === 'replace' && (p.path[1] as number) < 5) || (p.op === 'add' && (p.path[1] as number) >= 5))).toBe(true);

    const main = clone(base);
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(main).toEqual(next);
    importPhoto(main, 'imp');

    // renderer: снимок main с импортом; отмена — обратные патчи и в renderer, и в main.
    let renderer = clone(main);
    applyProjectPatches(main, inverse as ProjectPatch[]);
    renderer = applyPatches(renderer, inverse);
    expect(ids(main.slots)).toEqual(['a', 'b', 'c', 'd', 'e', 'imp']);
    expect(renderer).toEqual(main);

    applyProjectPatches(main, patches as ProjectPatch[]);
    renderer = applyPatches(renderer, patches);
    expect(ids(main.slots)).toEqual(['a', 'x', 'y', 'z', 'b', 'c', 'd', 'e', 'imp']);
    expect(renderer).toEqual(main);
  });

  test('удаление пустой: обрезка длины; отмена после импорта возвращает её на место', () => {
    const base = project(insertEmptySlots(photos('a', 'b', 'c'), ['x', 'y'], 0));
    const { next, patches, inverse } = edit(base, (slots) => removeEmptySlots(slots, ['x']));
    expect(ids(next.slots)).toEqual(['y', 'a', 'b', 'c']);

    const main = clone(base);
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(main).toEqual(next);
    importPhoto(main, 'imp');
    applyProjectPatches(main, inverse as ProjectPatch[]);
    expect(ids(main.slots)).toEqual(['x', 'y', 'a', 'b', 'c', 'imp']);
    expect(main.slots[0]).toEqual(createSlot('x'));
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(ids(main.slots)).toEqual(['y', 'a', 'b', 'c', 'imp']);
  });

  test('пакет пришёл в main после импорта, которого renderer ещё не видел', () => {
    const base = project(photos('a', 'b', 'c'));
    const { patches } = edit(base, (slots) => insertEmptySlots(slots, ['x'], 0));
    const main = clone(base);
    importPhoto(main, 'imp');
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(ids(main.slots)).toEqual(['x', 'a', 'b', 'c', 'imp']);
  });

  test('без изменений — без патчей', () => {
    const base = project(photos('a', 'b'));
    expect(edit(base, (slots) => [...slots]).patches).toEqual([]);
  });
});
