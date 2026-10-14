// «Подогнать текущую сетку» (ADR 0025): стоимость позиций, перестановка подвижных фото венгерским алгоритмом,
// фаза паттерна, одна правка через Immer и main.
import { enablePatches, produceWithPatches } from 'immer';
import { describe, expect, test } from 'vitest';
import { costStats, targetCost } from '@core/match/cost';
import { DEFAULT_LEVELS, hardTarget, levelL, type Level } from '@core/pattern/levels';
import { fitGrid, fitRole, fitShifts, fittedSlots, STAY_EPSILON, type GridFit } from '@core/pattern/fit';
import { makePattern, rotatePattern, targetAt, targetsAgree, withPatternTargets } from '@core/pattern/pattern';
import { mulberry32 } from '@core/random';
import { createProject, createSlot } from '@core/project/defaults';
import { applyProjectPatches, type ProjectPatch } from '@core/project/patch';
import { assignSlots } from '@core/project/slots';
import type { Features, Pattern, Project, Slot } from '@core/project/types';

enablePatches();

const ASSET = 'aaaaaaaaaaaaaaaa';
const lvl = (level: Level) => hardTarget(levelL(level, DEFAULT_LEVELS));
/** Паттерн из строки уровней по клеткам периода: «LDLDLD» — LDL/DLD. */
const pattern = (levels: string): Pattern => makePattern('string', [...levels].map((c) => lvl(c as Level)));
const LDL_DLD = pattern('LDLDLD');

/** Признаки однотонной серой плитки. */
function gray(L: number): Features {
  return {
    meanL: L,
    p05L: L,
    p50L: L,
    p95L: L,
    lHist: new Array(8).fill(0),
    meanA: 0,
    meanB: 0,
    meanC: 0,
    hueHist: new Array(12).fill(0),
    palette: [{ lab: [L, 0, 0], share: 1 }],
    neutralShare: 1,
    highKeyShare: 0,
    lowKeyShare: 0,
    busyness: 0,
  };
}

/**
 * Сетка по строке: символ — позиция. Строчная буква — фото этого уровня (l 0.80, m 0.62, d 0.44, «x» — L 0.70),
 * заглавная — то же фото, опубликованное; «*» после буквы — `choiceLocked`; «.» — пустая позиция; «?» после
 * буквы — признаков нет. Id слота — номер позиции с буквой: «0l», «1d».
 */
function grid(spec: string, p: Pattern | null = LDL_DLD, pinned: Project['grid']['pinned'] = 0) {
  const levels: Record<string, number> = { l: 0.8, m: 0.62, d: 0.44, x: 0.7 };
  const features: Record<string, Features> = {};
  const slots: Slot[] = [];
  for (const token of spec.replaceAll('/', '').match(/[.a-zA-Z][*?]*/g) ?? []) {
    const i = slots.length;
    const ch = token[0] as string;
    if (ch === '.') {
      slots.push(createSlot(`${i}.`));
      continue;
    }
    const slot = createSlot(`${i}${ch.toLowerCase()}`, ASSET);
    if (ch !== ch.toLowerCase()) slot.state = 'published';
    if (token.includes('*')) slot.choiceLocked = true;
    if (!token.includes('?')) features[slot.id] = gray(levels[ch.toLowerCase()] as number);
    slots.push(slot);
  }
  const project = createProject('p');
  project.grid.pinned = pinned;
  if (p) project.pattern = p;
  project.slots = p ? withPatternTargets(slots, p, pinned) : slots;
  return { project, features };
}

function fitOf(spec: string, p: Pattern = LDL_DLD, pinned: Project['grid']['pinned'] = 0): GridFit & { project: Project; features: Record<string, Features> } {
  const { project, features } = grid(spec, p, pinned);
  const result = fitGrid(project, features);
  if (result.kind !== 'fit') throw new Error(`подгонки нет: ${result.kind}`);
  return { ...result, project, features };
}

const cost = (f: Features, p: Pattern, index: number, pinned = 0) => targetCost(costStats(f), targetAt(p, index, pinned)!);

describe('стоимость позиций', () => {
  test('у каждой позиции с фото — стоимость в цели её позиции, сумма — по всем позициям ленты с фото', () => {
    const fit = fitOf('lxd/dLd*/.ml');
    const { project, features } = fit;
    const expected = project.slots.map((slot, i) => (features[slot.id] ? cost(features[slot.id]!, LDL_DLD, i) : null));
    expect(fit.positions.map((p) => p.cost)).toEqual(expected);
    expect(fit.positions[6]?.cost).toBeNull();
    expect(fit.before).toBeCloseTo(expected.reduce<number>((sum, c) => sum + (c ?? 0), 0), 12);
    // x (0.70) на светлой позиции — 1.67 допуска, d на светлой — 6.
    expect(fit.positions[1]?.cost).toBeCloseTo((0.7 - 0.44) / 0.06, 9);
    expect(fit.positions[2]?.cost).toBeCloseTo((0.8 - 0.44) / 0.06, 9);
  });

  test('роли позиций: подвижные — запланированные с фото вне закреплённых и без choiceLocked', () => {
    const { project } = grid('lLd*/.dl/d', LDL_DLD, 1);
    expect(project.slots.map((slot, i) => fitRole(slot, i, 1))).toEqual([
      'pinned',
      'published',
      'locked',
      'empty',
      'movable',
      'movable',
      'movable',
    ]);
  });
});

describe('перестановка', () => {
  test('светлые — на светлые позиции, тёмные — на тёмные; сумма после — как у нового порядка', () => {
    // Светлые позиции LDL/DLD — 0, 2, 4, 6, 8. Светлые фото на 3 и 5 (x — 0.70), тёмные на 2 и 6.
    const fit = fitOf('ldd/llx/ddl');
    expect(fit.order).toEqual(['0l', '1d', '3l', '2d', '4l', '6d', '5x', '7d', '8l']);
    expect(fit.shift).toBe(0);
    expect(fit.moved).toBe(4);
    expect(fit.positions.map((p) => p.to)).toEqual([0, 1, 3, 2, 4, 6, 5, 7, 8]);
    const after = fit.order.map((id, i) => cost(fit.features[id]!, fit.pattern, i));
    expect(fit.costsAfter).toEqual(after);
    expect(fit.after).toBeCloseTo(after.reduce((a, b) => a + b, 0), 12);
    // Остаётся только x: 0.70 на светлой позиции — 1.67 допуска.
    expect(fit.after).toBeCloseTo((0.8 - 0.7) / 0.06, 9);
    expect(fit.after).toBeLessThan(fit.before);
  });

  test('уезжают ближайшие: из равных по стоимости перестановок — с наименьшим сдвигом', () => {
    // Светлые на 3 и 5 (тёмные позиции), тёмные на 2 и 6 (светлые): обмен соседей, а не 3 ↔ 6 и 5 ↔ 2.
    const fit = fitOf('ldd/lll/ddl');
    expect(fit.order).toEqual(['0l', '1d', '3l', '2d', '4l', '6d', '5l', '7d', '8l']);
    expect(fit.after).toBe(0);
    for (const p of fit.positions) expect(Math.abs(p.to - p.index)).toBeLessThanOrEqual(1);
  });

  test('равные фото не переставляются: сетка в цели остаётся как есть', () => {
    const fit = fitOf('ldl/dld/ldl');
    expect(fit.order).toEqual(fit.from);
    expect(fit.moved).toBe(0);
    expect(fit.positions.every((p) => p.to === p.index)).toBe(true);
    const same = fitOf('mmm/mmm/mmm', pattern('MMM'));
    expect(same.moved).toBe(0);
  });

  test('опубликованные, закреплённые, зафиксированные и пустые стоят на местах; цели за ними не ломаются', () => {
    // Позиция 0 закреплена (тёмное фото на ней чужое, но не двигается), 1 — опубликованная светлая,
    // 2 — зафиксированная тёмная, 3 — пустая.
    const fit = fitOf('dLd*/.ld/ldl', LDL_DLD, 1);
    for (const index of [0, 1, 2, 3]) expect(fit.order[index]).toBe(fit.from[index]);
    for (const p of fit.positions.filter((p) => p.role !== 'movable')) expect(p.to).toBe(p.index);
    expect(fit.positions[0]?.cost).toBeNull();
    expect(fit.positions[3]?.cost).toBeNull();
    // Опубликованная и зафиксированная входят в сумму.
    expect(fit.positions[1]?.cost).toBeCloseTo((0.8 - 0.44) / 0.06, 9);
    expect(fit.positions[2]?.cost).toBeCloseTo((0.8 - 0.44) / 0.06, 9);
  });

  test('оптимум против перебора перестановок подвижных и всех фаз', () => {
    const random = mulberry32(7);
    const kinds = 'lmdx';
    for (let trial = 0; trial < 16; trial++) {
      const spec = Array.from({ length: 8 }, (_, i) => {
        if (i === 3 && trial % 3 === 0) return 'D';
        if (i === 6 && trial % 4 === 0) return 'm*';
        return kinds[Math.floor(random() * kinds.length)] as string;
      }).join('');
      const p = trial % 2 === 0 ? LDL_DLD : pattern('LLLDDD');
      const fit = fitOf(spec, p);
      const best = bruteForce(fit.project, fit.features);
      // Сумма — наименьшая с точностью до надбавки; сумма с надбавкой — ровно наименьшая: из равных
      // перестановок выбрана та, где фото едут ближе.
      expect(fit.after).toBeLessThanOrEqual(best.real + 8 * 8 * STAY_EPSILON);
      const distance = fit.positions.reduce((sum, p) => sum + Math.abs(p.to - p.index), 0);
      expect(fit.after + STAY_EPSILON * distance).toBeCloseTo(best.penalized, 10);
      expect(fit.after).toBeLessThanOrEqual(fit.before + 1e-9);
    }
  });
});

/**
 * Перебор всех перестановок подвижных фото и всех допустимых фаз: наименьшая сумма и наименьшая сумма
 * с надбавкой ε за каждую позицию переезда.
 */
function bruteForce(project: Project, features: Record<string, Features>): { real: number; penalized: number } {
  const p = project.pattern!;
  const { slots } = project;
  const pinned = project.grid.pinned;
  const roles = slots.map((slot, i) => fitRole(slot, i, pinned));
  const movable = roles.flatMap((role, i) => (role === 'movable' ? [i] : []));
  let real = Infinity;
  let penalized = Infinity;
  for (const shift of fitShifts(p)) {
    const rotated = rotatePattern(p, shift);
    // table[a][b] — фото с позиции movable[a] на позиции movable[b].
    const table = movable.map((from) => movable.map((to) => cost(features[slots[from]!.id]!, rotated, to, pinned)));
    const moveCost = movable.map((from) => movable.map((to) => STAY_EPSILON * Math.abs(from - to)));
    let fixed = 0;
    roles.forEach((role, i) => {
      if (role === 'published' || role === 'locked') fixed += cost(features[slots[i]!.id]!, rotated, i, pinned);
    });
    const used = new Array<boolean>(movable.length).fill(false);
    const permute = (k: number, sum: number, penalty: number) => {
      if (sum >= real + 1e-3 && sum + penalty >= penalized) return;
      if (k === movable.length) {
        real = Math.min(real, sum);
        penalized = Math.min(penalized, sum + penalty);
        return;
      }
      for (let a = 0; a < movable.length; a++) {
        if (used[a]) continue;
        used[a] = true;
        permute(k + 1, sum + (table[a]![k] as number), penalty + (moveCost[a]![k] as number));
        used[a] = false;
      }
    };
    permute(0, fixed, 0);
  }
  return { real, penalized };
}

describe('фаза паттерна', () => {
  test('одиночные — любой сдвиг в периоде, пачки — на целые ряды', () => {
    expect(LDL_DLD.postingMode).toBe('single');
    expect(fitShifts(LDL_DLD)).toEqual([0, 1, 2, 3, 4, 5]);
    const stripes = pattern('LLLDDD');
    expect(stripes.postingMode).toBe('batch');
    expect(fitShifts(stripes)).toEqual([0, 3]);
    expect(fitShifts(pattern('LLLMMMDDD'))).toEqual([0, 3, 6]);
  });

  test('шахматка: больше тёмных фото, чем тёмных позиций, — фаза 1, сетка начинается с тёмного', () => {
    const fit = fitOf('ldl/ddl/dld');
    expect(fit.shift).toBe(1);
    expect(fit.pattern).toEqual(rotatePattern(LDL_DLD, 1));
    expect(fit.pattern.postingMode).toBe('single');
    expect(fit.order).toEqual(['1d', '0l', '3d', '2l', '4d', '5l', '6d', '7l', '8d']);
    expect(fit.after).toBe(0);
  });

  test('пачки: полосы сдвигаются на ряд, а не на позицию', () => {
    // Полосы LLL/DDD: тёмные фото в первом и третьем ряду. Сдвиг на ряд делает их тёмными рядами.
    const fit = fitOf('ddd/lll/ddd', pattern('LLLDDD'));
    expect(fit.shift).toBe(3);
    expect(fit.moved).toBe(0);
    expect(fit.after).toBe(0);
  });

  test('при равной сумме — меньше переездов, при равных переездах остаётся нынешняя фаза', () => {
    // У LDL/DLD сдвиги 0, 2 и 4 дают те же цели.
    const fit = fitOf('ldl/dld/ldl');
    expect(fit.shift).toBe(0);
    expect(fit.pattern).toEqual(LDL_DLD);
    // Однотонный паттерн: все фазы равны.
    expect(fitOf('mmm/mmm', pattern('MMM')).shift).toBe(0);
    // Подвижные одинаково хороши в фазе 0 и 1, но в фазе 0 переехали бы все восемь — фаза 1 без переездов.
    const phase = fitOf('.ld/ldl/dld');
    expect(phase.after).toBe(0);
    expect(phase.shift).toBe(1);
    expect(phase.moved).toBe(0);
  });

  test('опубликованные входят в выбор фазы', () => {
    // Подвижные стоят ровно по фазе 0, но опубликованная тёмная на позиции 0 (светлой в фазе 0) перевешивает:
    // фаза 1 и восемь переездов. Без неё (пустая позиция) осталась бы нынешняя фаза.
    const published = fitOf('Ddl/dld/ldl');
    expect(published.shift).toBe(1);
    expect(published.order[0]).toBe('0d');
    expect(published.after).toBe(0);
    expect(published.moved).toBe(8);
    const empty = fitOf('.dl/dld/ldl');
    expect(empty.shift).toBe(0);
    expect(empty.moved).toBe(0);
  });
});

describe('признаки', () => {
  test('нужны признаки всех участвующих плиток: подвижных, опубликованных и зафиксированных', () => {
    const { project, features } = grid('l?dL?/d*?.l', LDL_DLD, 0);
    const result = fitGrid(project, features);
    expect(result).toEqual({ kind: 'pending', missing: ['0l', '2l', '3d'] });
  });

  test('закреплённым и пустым признаки не нужны', () => {
    const { project, features } = grid('d?ld/.ld', LDL_DLD, 1);
    expect(fitGrid(project, features).kind).toBe('fit');
  });

  test('без паттерна подгонки нет', () => {
    const { project, features } = grid('ldl/dld', null);
    expect(fitGrid(project, features)).toEqual({ kind: 'none' });
  });
});

describe('«Переставить» одной правкой', () => {
  /** Правка через Immer, как fitTiles в renderer, и те же патчи в main: результат совпадает, отмена возвращает прежнее. */
  function roundTrip(base: Project, recipe: (draft: Project) => void): Project {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const [next, patches, inverse] = produceWithPatches(base, recipe);
    const main = clone(base);
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(main).toEqual(next);
    const undone = clone(main);
    applyProjectPatches(undone, inverse as ProjectPatch[]);
    expect(undone).toEqual(base);
    return main;
  }

  function apply(fit: GridFit & { project: Project }): Project {
    const base = fit.project;
    return roundTrip(base, (draft) => {
      const next = fittedSlots(base, fit);
      if (!next) throw new Error('проект изменился');
      if (JSON.stringify(base.pattern) !== JSON.stringify(fit.pattern)) draft.pattern = fit.pattern;
      assignSlots(draft.slots, base.slots, next);
    });
  }

  test('порядок, фаза и цели — одним пакетом, main принимает, отмена возвращает прежнее', () => {
    // Зафиксированная светлая на 1 и опубликованная тёмная на 8 держат фазу 1; светлая 2 и тёмная 3 меняются.
    const fit = fitOf('dl*l/ddl/dlD', LDL_DLD);
    expect(fit.shift).toBe(1);
    expect(fit.order).toEqual(['0d', '1l', '3d', '2l', '4d', '5l', '6d', '7l', '8d']);
    const applied = apply(fit);
    expect(applied.slots.map((slot) => slot.id)).toEqual(fit.order);
    expect(applied.pattern).toEqual(fit.pattern);
    expect(targetsAgree(applied.slots, applied.pattern!, 0)).toBe(true);
    expect(applied.slots.map((slot) => slot.target?.L)).toEqual([0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44, 0.8, 0.44]);
  });

  test('без смены фазы — только порядок и цели; закреплённые без цели', () => {
    const fit = fitOf('ddl/ldd/ldl', LDL_DLD, 1);
    expect(fit.shift).toBe(0);
    expect(fit.order).toEqual(['0d', '1d', '2l', '4d', '3l', '5d', '6l', '7d', '8l']);
    const applied = apply(fit);
    expect(applied.pattern).toEqual(LDL_DLD);
    expect(applied.slots[0]?.target).toBeUndefined();
    expect(applied.slots.map((slot) => slot.id)).toEqual(fit.order);
  });

  test('проект изменился после подгонки — fittedSlots ничего не предлагает', () => {
    const fit = fitOf('ldd/llx/ddl');
    const { project } = fit;
    expect(fittedSlots(project, fit)).not.toBeNull();
    expect(fittedSlots({ ...project, slots: project.slots.slice(1) }, fit)).toBeNull();
    expect(fittedSlots({ ...project, slots: [...project.slots].reverse() }, fit)).toBeNull();
    expect(fittedSlots({ ...project, pattern: pattern('LLLDDD') }, fit)).toBeNull();
    const { pattern: _p, ...withoutPattern } = project;
    expect(fittedSlots(withoutPattern, fit)).toBeNull();
    // Фаза 1 сверяется по нынешнему паттерну, сдвинутому на неё.
    const phase = fitOf('ldl/ddl/dld');
    expect(phase.shift).toBe(1);
    expect(fittedSlots(phase.project, phase)).not.toBeNull();
    expect(fittedSlots({ ...phase.project, pattern: phase.pattern }, phase)).toBeNull();
  });
});
