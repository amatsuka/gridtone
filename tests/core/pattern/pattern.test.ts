// Цели позиций из паттерна и устойчивость к сдвигу (ADR 0023).
import { enablePatches, produceWithPatches } from 'immer';
import { describe, expect, test } from 'vitest';
import { createProject, createSlot } from '@core/project/defaults';
import { moveSlots, shiftSlots } from '@core/project/order';
import { applyProjectPatches, type ProjectPatch } from '@core/project/patch';
import { assignSlots, insertEmptySlots, removeEmptySlots } from '@core/project/slots';
import type { Pattern, Project, Slot, SlotTarget } from '@core/project/types';
import { DEFAULT_LEVELS, hardTarget, levelL, type Level } from '@core/pattern/levels';
import {
  cellsMatch,
  clearTargets,
  makePattern,
  periodCell,
  positionTarget,
  postingModeOf,
  rotatePattern,
  singlePostShift,
  targetAt,
  targetLab,
  targetsAgree,
  withPatternTargets,
} from '@core/pattern/pattern';

enablePatches();

const ASSET = 'aaaaaaaaaaaaaaaa';
const lvl = (level: Level) => hardTarget(levelL(level, DEFAULT_LEVELS));
/** Паттерн из строки уровней по позициям: «LDLDLD» — два ряда. */
const pattern = (levels: string, source: Pattern['source'] = 'string'): Pattern =>
  makePattern(source, [...levels].map((c) => lvl(c as Level)));

function photos(...ids: string[]): Slot[] {
  return ids.map((id) => createSlot(id, ASSET));
}

function project(slots: Slot[], pinned: Project['grid']['pinned'] = 0, p?: Pattern): Project {
  const result = createProject('p');
  result.assets[ASSET] = {
    id: ASSET,
    path: '/ph/a.jpg',
    hash: 'a'.repeat(64),
    w: 3000,
    h: 4000,
    format: 'jpeg',
    icc: 'embedded',
    importedAt: '2026-10-14T00:00:00.000Z',
  };
  result.grid.pinned = pinned;
  if (p) result.pattern = p;
  result.slots = p ? withPatternTargets(slots, p, pinned) : slots;
  return result;
}

const Ls = (slots: readonly Slot[]) => slots.map((slot) => slot.target?.L ?? null);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Правка через Immer, как в renderer, и те же патчи в main: результат совпадает, отмена возвращает прежнее. */
function roundTrip(base: Project, recipe: (draft: Project) => void): Project {
  const [next, patches, inverse] = produceWithPatches(base, recipe);
  const main = clone(base);
  applyProjectPatches(main, patches as ProjectPatch[]);
  expect(main).toEqual(next);
  const undone = clone(main);
  applyProjectPatches(undone, inverse as ProjectPatch[]);
  expect(undone).toEqual(base);
  return main;
}

/** Перестановка, как rewriteSlots в renderer: новый порядок с целями позиций, одной правкой. */
function rewrite(base: Project, arrange: (slots: readonly Slot[], pinned: number) => Slot[]): Project {
  return roundTrip(base, (draft) => {
    const before = base.slots;
    assignSlots(draft.slots, before, withPatternTargets(arrange(before, base.grid.pinned), base.pattern, base.grid.pinned, before));
  });
}

describe('цели по позициям', () => {
  test('позиция i получает клетку cells[i mod 3 · periodRows]', () => {
    const p = pattern('LDLDLD');
    expect(p).toMatchObject({ source: 'string', periodRows: 2 });
    expect([0, 1, 2, 5, 6, 7, 13].map((i) => targetAt(p, i, 0)?.L)).toEqual([0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.44]);
    expect(periodCell(p, 7)).toEqual({ cell: 1, row: 0, column: 1 });
    expect(periodCell(p, 5)).toEqual({ cell: 5, row: 1, column: 2 });
  });

  test('у закреплённых цели нет; паттерн привязан к позиции 0, а не к первой после закреплённых', () => {
    const p = pattern('LLLDDD');
    expect([0, 1, 2, 3].map((i) => targetAt(p, i, 2)?.L ?? null)).toEqual([null, null, 0.8, 0.44]);
  });

  test('цель — копия клетки: её правка не меняет паттерн', () => {
    const p = pattern('LDL');
    (targetAt(p, 0, 0) as SlotTarget).L = 0.1;
    expect(p.cells[0]?.L).toBe(0.8);
  });

  test('withPatternTargets: цели всех позиций, неизменившиеся слоты — те же объекты', () => {
    const p = pattern('LDLDLD');
    const slots = photos('a', 'b', 'c', 'd');
    const targeted = withPatternTargets(slots, p, 1);
    expect(Ls(targeted)).toEqual([null, 0.44, 0.8, 0.44]);
    expect(targeted[0]).toBe(slots[0]);
    expect(targeted[1]).not.toBe(slots[1]);
    expect(withPatternTargets(targeted, p, 1)).toEqual(targeted);
    expect(withPatternTargets(targeted, p, 1).every((slot, i) => slot === targeted[i])).toBe(true);
    expect(targetsAgree(targeted, p, 1)).toBe(true);
    expect(targetsAgree(slots, p, 1)).toBe(false);
    expect(targetsAgree(targeted, p, 0)).toBe(false);
  });

  test('без паттерна у позиций остаются прежние цели; clearTargets снимает все', () => {
    const slots = photos('a', 'b', 'c');
    slots[0]!.target = lvl('L');
    const moved = moveSlots(slots, ['a'], 2, 0);
    expect(moved.map((slot) => slot.id)).toEqual(['b', 'c', 'a']);
    const kept = withPatternTargets(moved, undefined, 0, slots);
    expect(Ls(kept)).toEqual([0.8, null, null]);
    expect(kept[0]?.id).toBe('b');
    expect(clearTargets(kept).map((slot) => 'target' in slot)).toEqual([false, false, false]);
    expect(clearTargets(moved)[0]).toBe(moved[0]);
  });

  test('цель новой позиции в конце — по паттерну (импорт в main)', () => {
    const p = pattern('LDLDLD');
    const base = project(photos('a', 'b'), 0, p);
    expect(positionTarget(base, 2)).toEqual(lvl('L'));
    expect(positionTarget(base, 3)).toEqual(lvl('D'));
    expect(positionTarget({ ...base, grid: { ...base.grid, pinned: 3 } }, 2)).toBeUndefined();
    expect(positionTarget(project(photos('a')), 1)).toBeUndefined();
    // Импорт дописывает слот с целью его позиции: цели согласованы с паттерном.
    base.slots.push({ ...createSlot('c', ASSET), target: positionTarget(base, base.slots.length)! });
    expect(targetsAgree(base.slots, p, 0)).toBe(true);
  });
});

describe('синхронизация целей с позициями (одна правка, как в renderer)', () => {
  const p = pattern('LDLDLD');
  const base = () => project(photos('a', 'b', 'c', 'd', 'e', 'f'), 0, p);
  const ids = (proj: Project) => proj.slots.map((slot) => slot.id);

  test('перестановка: фото на новом месте получает цель этого места', () => {
    const moved = rewrite(base(), (slots, pinned) => moveSlots(slots, ['a'], 1, pinned));
    expect(ids(moved)).toEqual(['b', 'a', 'c', 'd', 'e', 'f']);
    expect(Ls(moved.slots)).toEqual(Ls(base().slots));
    expect(moved.slots[1]?.target?.L).toBe(0.44);
    const shifted = rewrite(base(), (slots, pinned) => shiftSlots(slots, ['c'], 3, pinned));
    expect(ids(shifted)).toEqual(['a', 'b', 'd', 'e', 'f', 'c']);
    expect(targetsAgree(shifted.slots, p, 0)).toBe(true);
  });

  test('вставка и удаление пустых: цели сдвинутых фото пересчитаны, у пустых — свои', () => {
    const inserted = rewrite(base(), (slots, pinned) => insertEmptySlots(slots, ['e1', 'e2', 'e3'], pinned));
    expect(ids(inserted)).toEqual(['e1', 'e2', 'e3', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(Ls(inserted.slots)).toEqual([0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8]);
    // Фото a сдвинуто на ряд: было L, стало D.
    expect(inserted.slots[3]?.target?.L).toBe(0.44);
    expect(targetsAgree(inserted.slots, p, 0)).toBe(true);
    const removed = rewrite(inserted, (slots) => removeEmptySlots(slots, ['e2']));
    expect(ids(removed)).toEqual(['e1', 'e3', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(targetsAgree(removed.slots, p, 0)).toBe(true);
  });

  test('смена закреплённых: закреплённая позиция теряет цель, открепление возвращает', () => {
    const repin = (proj: Project, pinned: Project['grid']['pinned']) =>
      roundTrip(proj, (draft) => {
        draft.grid.pinned = pinned;
        assignSlots(draft.slots, proj.slots, withPatternTargets(proj.slots, proj.pattern, pinned, proj.slots));
      });
    const pinned = repin(base(), 2);
    expect(Ls(pinned.slots)).toEqual([null, null, 0.8, 0.44, 0.8, 0.44]);
    const unpinned = repin(pinned, 0);
    expect(unpinned.slots).toEqual(base().slots);
  });

  test('перестановка после смены закреплённых: закреплённые не двигаются и цели не получают', () => {
    const proj = project(photos('a', 'b', 'c', 'd'), 1, p);
    const moved = rewrite(proj, (slots, pinned) => shiftSlots(slots, ['b'], 1, pinned));
    expect(ids(moved)).toEqual(['a', 'c', 'b', 'd']);
    expect(Ls(moved.slots)).toEqual([null, 0.44, 0.8, 0.44]);
  });
});

describe('устойчивость к сдвигу', () => {
  test('LDL/DLD — шахматка на трёх колонках: один пост — тот же паттерн на ряд ниже', () => {
    expect(postingModeOf(pattern('LDLDLD').cells)).toBe('single');
    expect(singlePostShift(pattern('LDLDLD').cells)).toBe(1);
  });

  test('полосы, колонки и стык периода — пачками по 3', () => {
    expect(postingModeOf(pattern('LLLDDD').cells)).toBe('batch');
    expect(postingModeOf(pattern('LDL').cells)).toBe('batch');
    expect(postingModeOf(pattern('LMD').cells)).toBe('batch');
    // LDL/DLD/LDL: внутри периода — шахматка, но на стыке периодов две L подряд.
    expect(postingModeOf(pattern('LDLDLDLDL').cells)).toBe('batch');
    expect(singlePostShift(pattern('LDLDLDLDL').cells)).toBeNull();
  });

  test('однотонный паттерн переживает любой сдвиг', () => {
    expect(postingModeOf(pattern('MMM').cells)).toBe('single');
    expect(singlePostShift(pattern('MMM').cells)).toBe(0);
  });

  test('клетки совпадают в пределах допуска: L, тон и хрома; цвет только у одной — не совпали', () => {
    const a = hardTarget(0.6);
    expect(cellsMatch(a, hardTarget(0.65))).toBe(true);
    expect(cellsMatch(a, hardTarget(0.67))).toBe(false);
    const warm = hardTarget(0.6, { hue: 60, chroma: 0.05 });
    expect(cellsMatch(warm, hardTarget(0.6, { hue: 72, chroma: 0.06 }))).toBe(true);
    expect(cellsMatch(warm, hardTarget(0.6, { hue: 80, chroma: 0.05 }))).toBe(false);
    expect(cellsMatch(warm, hardTarget(0.6, { hue: 60, chroma: 0.08 }))).toBe(false);
    expect(cellsMatch(warm, a)).toBe(false);
    expect(cellsMatch(hardTarget(0.6, { chroma: 0.01 }), a)).toBe(false);
    // Через 0°/360°.
    expect(cellsMatch(hardTarget(0.6, { hue: 355, chroma: 0.05 }), hardTarget(0.6, { hue: 5, chroma: 0.05 }))).toBe(true);
    // Допуск — меньший из двух.
    const loose = { ...hardTarget(0.65), tolerance: { L: 0.2, hue: 15, chroma: 0.02 } };
    expect(cellsMatch(loose, hardTarget(0.6))).toBe(true);
    expect(cellsMatch(loose, hardTarget(0.5))).toBe(false);
  });

  test('шахматка уровнями в пределах допуска — одиночные: почти равные клетки считаются равными', () => {
    const cells = [0.8, 0.44, 0.78, 0.46, 0.8, 0.44].map((L) => hardTarget(L));
    expect(postingModeOf(cells)).toBe('single');
  });
});

describe('фаза паттерна', () => {
  test('rotatePattern сдвигает клетки по кругу, режим публикации тот же', () => {
    const p = pattern('LMDDLM', 'generator');
    const once = rotatePattern(p, 1);
    expect(once.cells.map((c) => c.L)).toEqual([0.62, 0.44, 0.44, 0.8, 0.62, 0.8]);
    expect(once).toMatchObject({ source: 'generator', periodRows: 2, postingMode: p.postingMode });
    expect(targetAt(once, 0, 0)).toEqual(targetAt(p, 1, 0));
    expect(rotatePattern(p, 6)).toEqual(p);
    expect(rotatePattern(p, -1)).toEqual(rotatePattern(p, 5));
    expect(rotatePattern(once, -1)).toEqual(p);
  });
});

describe('цвет цели', () => {
  test('OKLab цели: без тона — серый той же L', () => {
    expect(targetLab(hardTarget(0.5))).toEqual([0.5, 0, 0]);
    const [L, a, b] = targetLab(hardTarget(0.5, { hue: 90, chroma: 0.05 }));
    expect(L).toBe(0.5);
    expect(a).toBeCloseTo(0, 10);
    expect(b).toBeCloseTo(0.05, 10);
    expect(targetLab(hardTarget(0.5, { chroma: 0.01 }))).toEqual([0.5, 0, 0]);
  });
});
