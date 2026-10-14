// «Подогнать текущую сетку» (docs/spec.md, «Модуль 4. Паттерны»; docs/decisions/0025-fit.md). У каждой позиции
// ленты с фото — стоимость попадания в цель (match/cost.ts). Подвижные фото — запланированные, не закреплённые,
// без choiceLocked — переставляются венгерским алгоритмом (match/assign.ts) так, чтобы сумма была наименьшей;
// опубликованные, закреплённые, зафиксированные и пустые позиции стоят на месте. Фаза паттерна перебирается:
// у «одиночных постов» — любой сдвиг в периоде, у «пачек» — на целые ряды; опубликованные и зафиксированные
// входят в сумму каждой фазы. Уйти с места дороже на ε за каждую позицию сдвига: равные фото не переставляются,
// а из равных перестановок выбирается та, где фото едут ближе. Результат — производные данные; «Переставить»
// пишет фазу, порядок и цели одной правкой (fittedSlots).
import { assign } from '../match/assign';
import { costStats, targetCost, type CostStats } from '../match/cost';
import { sameJson } from '../project/json';
import { isEmptySlot, isPinnedIndex } from '../project/slots';
import type { Features, Pattern, Project, Slot, SlotTarget } from '../project/types';
import { PATTERN_COLUMNS, periodLength, rotatePattern, withPatternTargets } from './pattern';

/**
 * Надбавка за уход с места — за каждую позицию сдвига. Много меньше любой заметной разницы (тысячная допуска
 * на 90 плитках), но больше погрешности сумм: из равных по стоимости перестановок побеждает та, где фото
 * переезжают меньше, а равные фото не переставляются вовсе.
 */
export const STAY_EPSILON = 1e-6;
/** Относительная погрешность при сравнении фаз: суммы, равные до неё, — равны, и остаётся более ранний сдвиг. */
const PHASE_TIE = 1e-9;

/**
 * Роль позиции в подгонке: подвижное фото; опубликованное или зафиксированное (`choiceLocked`) — на месте,
 * но в сумме; пустая и закреплённая позиции — вне подгонки.
 */
export type FitRole = 'movable' | 'published' | 'locked' | 'empty' | 'pinned';

export function fitRole(slot: Pick<Slot, 'assetId' | 'state' | 'choiceLocked'>, index: number, pinned: number): FitRole {
  if (isPinnedIndex(index, pinned)) return 'pinned';
  if (isEmptySlot(slot) || slot.state === 'empty') return 'empty';
  if (slot.state === 'published') return 'published';
  return slot.choiceLocked ? 'locked' : 'movable';
}

/** Участвует в сумме: позиция ленты с фото. */
const participates = (role: FitRole) => role === 'movable' || role === 'published' || role === 'locked';

export interface FitPosition {
  index: number;
  slotId: string;
  role: FitRole;
  /** Стоимость фото этой позиции в её цели при нынешней фазе; null — пустая или закреплённая позиция. */
  cost: number | null;
  /** Позиция, на которую переедет слот; у неподвижных — та же. */
  to: number;
}

export interface GridFit {
  /** Сдвиг фазы: позиция i получает клетку, что была у i + shift (`rotatePattern`). 0 — нынешняя фаза. */
  shift: number;
  /** Паттерн после подгонки — нынешний, сдвинутый на shift. */
  pattern: Pattern;
  /** id слотов по позициям сейчас: по ним «Переставить» проверяет, что проект не изменился. */
  from: string[];
  /** id слотов по позициям после подгонки. */
  order: string[];
  /** Позиции сейчас, в порядке сетки. */
  positions: FitPosition[];
  /** Стоимость каждой позиции после подгонки, по новым позициям; null — пустая или закреплённая. */
  costsAfter: (number | null)[];
  /** Сумма стоимостей позиций ленты с фото сейчас и после — опубликованные и зафиксированные тоже. */
  before: number;
  after: number;
  /** Сколько фото меняют позицию. */
  moved: number;
}

/** «none» — паттерна нет; «pending» — у участвующих плиток нет признаков (missing — их id). */
export type FitResult = { kind: 'none' } | { kind: 'pending'; missing: string[] } | ({ kind: 'fit' } & GridFit);

type FitFeatures = Pick<Features, 'meanL' | 'meanA' | 'meanB' | 'meanC'>;

/** Допустимые сдвиги фазы: у одиночных постов — любой в периоде, у пачек — на целые ряды. */
export function fitShifts(pattern: Pattern): number[] {
  const q = periodLength(pattern);
  const step = pattern.postingMode === 'single' ? 1 : PATTERN_COLUMNS;
  const shifts: number[] = [];
  for (let s = 0; s < q; s += step) shifts.push(s);
  return shifts;
}

interface PhaseFit {
  shift: number;
  /** Сумма стоимостей без надбавки. */
  real: number;
  /** С надбавкой за переезды — по ней сравниваются фазы. */
  penalized: number;
  /** Позиция, на которую едет фото с позиции movable[a]. */
  destination: number[];
}

/**
 * Подгонка сетки под паттерн по признакам плиток (ключ — id слота; свежие — забота вызывающего). Без паттерна —
 * «none», без признаков у какой-то из участвующих плиток — «pending».
 */
export function fitGrid(project: Pick<Project, 'grid' | 'slots' | 'pattern'>, features: Readonly<Record<string, FitFeatures | undefined>>): FitResult {
  const { pattern, slots } = project;
  const pinned = project.grid.pinned;
  if (!pattern) return { kind: 'none' };
  const roles = slots.map((slot, i) => fitRole(slot, i, pinned));
  const missing = slots.filter((slot, i) => participates(roles[i] as FitRole) && !features[slot.id]).map((slot) => slot.id);
  if (missing.length > 0) return { kind: 'pending', missing };

  const stats: (CostStats | null)[] = slots.map((slot, i) => (participates(roles[i] as FitRole) ? costStats(features[slot.id] as FitFeatures) : null));
  const q = periodLength(pattern);
  // Стоимость слота с позиции i в клетке c периода: цели всех фаз — клетки паттерна, считаем один раз.
  const cellCost = stats.map((s) => (s ? pattern.cells.map((cell) => targetCost(s, cell)) : null));
  /** Клетка позиции index при сдвиге shift. */
  const cellAt = (index: number, shift: number) => (index + shift) % q;
  const costAt = (from: number, to: number, shift: number) => (cellCost[from] as number[])[cellAt(to, shift)] as number;

  const movable = roles.flatMap((role, i) => (role === 'movable' ? [i] : []));
  const fixed = roles.flatMap((role, i) => (role === 'published' || role === 'locked' ? [i] : []));

  const fitPhase = (shift: number): PhaseFit => {
    let real = fixed.reduce((sum, i) => sum + costAt(i, i, shift), 0);
    const matrix = movable.map((from) => movable.map((to) => costAt(from, to, shift) + STAY_EPSILON * Math.abs(from - to)));
    const destination = assign(matrix).map((b) => movable[b] as number);
    let penalty = 0;
    movable.forEach((from, a) => {
      const to = destination[a] as number;
      real += costAt(from, to, shift);
      penalty += STAY_EPSILON * Math.abs(from - to);
    });
    return { shift, real, penalized: real + penalty, destination };
  };

  // Сдвиги с теми же клетками дают те же цели: считаем фазу один раз, остаётся более ранний сдвиг.
  const seen: SlotTarget[][] = [];
  let best: PhaseFit | null = null;
  for (const shift of fitShifts(pattern)) {
    const cells = rotatePattern(pattern, shift).cells;
    if (seen.some((other) => sameJson(other, cells))) continue;
    seen.push(cells);
    const phase = fitPhase(shift);
    if (!best || phase.penalized < best.penalized - PHASE_TIE * Math.max(1, Math.abs(best.penalized))) best = phase;
  }
  const chosen = best as PhaseFit;

  const from = slots.map((slot) => slot.id);
  const order = [...from];
  const to = slots.map((_, i) => i);
  movable.forEach((index, a) => {
    const destination = chosen.destination[a] as number;
    order[destination] = (slots[index] as Slot).id;
    to[index] = destination;
  });
  const source = new Map(to.map((destination, index) => [destination, index]));
  const costsAfter = order.map((_, i) => {
    const index = source.get(i) as number;
    return stats[index] ? costAt(index, i, chosen.shift) : null;
  });
  const positions = slots.map(
    (slot, i): FitPosition => ({
      index: i,
      slotId: slot.id,
      role: roles[i] as FitRole,
      cost: stats[i] ? costAt(i, i, 0) : null,
      to: to[i] as number,
    }),
  );
  const sum = (values: readonly (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return {
    kind: 'fit',
    shift: chosen.shift,
    pattern: chosen.shift === 0 ? pattern : rotatePattern(pattern, chosen.shift),
    from,
    order,
    positions,
    costsAfter,
    before: sum(positions.map((p) => p.cost)),
    after: sum(costsAfter),
    moved: order.filter((id, i) => id !== from[i]).length,
  };
}

/**
 * «Переставить»: слоты в порядке подгонки с целями своих позиций по паттерну подгонки. Те же объекты, что
 * в project.slots, кроме слотов с новой целью; в черновик Immer их пишет assignSlots, паттерн — сам вызывающий.
 * null — проект изменился после подгонки: другой состав или порядок слотов либо другой паттерн.
 */
export function fittedSlots(
  project: Pick<Project, 'grid' | 'slots' | 'pattern'>,
  fit: Pick<GridFit, 'shift' | 'from' | 'order' | 'pattern'>,
): Slot[] | null {
  const { slots, pattern } = project;
  if (!pattern || !sameJson(rotatePattern(pattern, fit.shift), fit.pattern)) return null;
  if (slots.length !== fit.from.length || slots.some((slot, i) => slot.id !== fit.from[i])) return null;
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  return withPatternTargets(
    fit.order.map((id) => byId.get(id) as Slot),
    fit.pattern,
    project.grid.pinned,
    slots,
  );
}
