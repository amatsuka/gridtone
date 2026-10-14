// Паттерн и цели позиций (docs/spec.md, «Модуль 4. Паттерны»; docs/decisions/0023-patterns.md). Цель — свойство
// позиции, а не фото: slot.target — проекция паттерна, позиция i получает клетку cells[i mod 3 · periodRows].
// Паттерн привязан к позиции 0 (левому верхнему углу); закреплённые позиции свою клетку пропускают и цели не
// получают. Перестановка, пустые позиции, смена закреплённых и импорт пересчитывают цели по позициям этими
// функциями, а main проверяет, что цели с паттерном согласованы (patch.ts).
import { hueDistance } from '../color/math';
import { cloneJson, sameJson } from '../project/json';
import { isPinnedIndex } from '../project/slots';
import type { Pattern, Project, Slot, SlotTarget, Vec3 } from '../project/types';

/** Колонок в сетке и в периоде паттерна. */
export const PATTERN_COLUMNS = 3;
/** Рядов в периоде — не больше: картинка-шаблон длиннее 30 рядов — уже не шаблон. */
export const PATTERN_MAX_ROWS = 30;

export type PostingMode = Pattern['postingMode'];

export const POSTING_MODE_LABELS: Record<PostingMode, string> = {
  single: 'Переживает одиночные посты',
  batch: 'Публиковать пачками по 3',
};

export const PATTERN_SOURCE_LABELS: Record<Pattern['source'], string> = {
  generator: 'генератор',
  string: 'строка',
  image: 'изображение',
  reference: 'референс',
};

/** Клеток в периоде. */
export function periodLength(pattern: Pick<Pattern, 'periodRows'>): number {
  return PATTERN_COLUMNS * pattern.periodRows;
}

/** Паттерн из клеток периода (по рядам, слева направо): период — число рядов, режим публикации — вычисленный. */
export function makePattern(source: Pattern['source'], cells: readonly SlotTarget[]): Pattern {
  if (cells.length === 0 || cells.length % PATTERN_COLUMNS !== 0) {
    throw new Error(`в периоде паттерна должно быть кратное ${PATTERN_COLUMNS} число клеток`);
  }
  const copy = cloneJson([...cells]);
  return { source, periodRows: copy.length / PATTERN_COLUMNS, postingMode: postingModeOf(copy), cells: copy };
}

/** Клетка периода, которая достаётся позиции index: номер и место в периоде. */
export function periodCell(pattern: Pick<Pattern, 'periodRows'>, index: number): { cell: number; row: number; column: number } {
  const cell = index % periodLength(pattern);
  return { cell, row: Math.floor(cell / PATTERN_COLUMNS), column: cell % PATTERN_COLUMNS };
}

/** Цель позиции index: копия её клетки; у закреплённой позиции цели нет. */
export function targetAt(pattern: Pattern, index: number, pinned: number): SlotTarget | undefined {
  if (isPinnedIndex(index, pinned)) return undefined;
  return cloneJson(pattern.cells[periodCell(pattern, index).cell] as SlotTarget);
}

/** Цель позиции index проекта: по его паттерну и закреплённым; без паттерна — нет. Так main дописывает импорт. */
export function positionTarget(project: Pick<Project, 'pattern' | 'grid'>, index: number): SlotTarget | undefined {
  return project.pattern ? targetAt(project.pattern, index, project.grid.pinned) : undefined;
}

/**
 * Слоты в порядке slots с целями своих позиций. С паттерном — клетка каждой позиции (у закреплённых цели нет);
 * без паттерна — цели, что были у этих позиций в before (до перестановки): цель остаётся на месте, фото на новом
 * месте получает цель этого места. Слот с другой целью — новый объект, остальные — те же: в черновик Immer
 * новый порядок пишет assignSlots.
 */
export function withPatternTargets(
  slots: readonly Slot[],
  pattern: Pattern | undefined,
  pinned: number,
  before: readonly Slot[] = slots,
): Slot[] {
  return slots.map((slot, i) => withTarget(slot, pattern ? targetAt(pattern, i, pinned) : before[i]?.target));
}

/** Слоты без целей: «Убрать цели». */
export function clearTargets(slots: readonly Slot[]): Slot[] {
  return slots.map((slot) => withTarget(slot, undefined));
}

function withTarget(slot: Slot, target: SlotTarget | undefined): Slot {
  if (sameJson(slot.target, target)) return slot;
  const { target: _old, ...rest } = slot;
  return target ? { ...rest, target } : rest;
}

/** Цели всех позиций — ровно клетки паттерна (у закреплённых цели нет). Это проверяет main после пакета. */
export function targetsAgree(slots: readonly Pick<Slot, 'target'>[], pattern: Pattern, pinned: number): boolean {
  return slots.every((slot, i) => sameJson(slot.target, targetAt(pattern, i, pinned)));
}

/** Запас на округление при сравнении с допуском. */
const EPSILON = 1e-9;

/**
 * Клетки совпадают: L, тон и хрома в пределах меньшего из двух допусков. Тон или хрома есть только у одной
 * клетки — не совпали.
 */
export function cellsMatch(a: SlotTarget, b: SlotTarget): boolean {
  const tolerance = {
    L: Math.min(a.tolerance.L, b.tolerance.L),
    hue: Math.min(a.tolerance.hue, b.tolerance.hue),
    chroma: Math.min(a.tolerance.chroma, b.tolerance.chroma),
  };
  if (Math.abs(a.L - b.L) > tolerance.L + EPSILON) return false;
  if ((a.hue === undefined) !== (b.hue === undefined) || (a.chroma === undefined) !== (b.chroma === undefined)) return false;
  if (a.hue !== undefined && hueDistance(a.hue, b.hue as number) > tolerance.hue + EPSILON) return false;
  if (a.chroma !== undefined && Math.abs(a.chroma - (b.chroma as number)) > tolerance.chroma + EPSILON) return false;
  return true;
}

/**
 * Устойчивость к сдвигу. Новый пост сдвигает ленту на позицию: на месте i оказывается то, что было на i − 1.
 * Паттерн переживает одиночные посты, если это он же, сдвинутый на целое число рядов k:
 * cells[j] ≈ cells[j + 1 + 3k] для всех j (по кругу периода). Возвращает k или null — тогда только пачками по 3:
 * сдвиг на три позиции всегда равен сдвигу на ряд.
 */
export function singlePostShift(cells: readonly SlotTarget[]): number | null {
  const q = cells.length;
  const rows = q / PATTERN_COLUMNS;
  for (let k = 0; k < rows; k++) {
    const shift = (1 + PATTERN_COLUMNS * k) % q;
    if (cells.every((cell, j) => cellsMatch(cell, cells[(j + shift) % q] as SlotTarget))) return k;
  }
  return null;
}

/** «Переживает одиночные посты» или «пачками по 3». Считает core при записи паттерна, main сверяет. */
export function postingModeOf(cells: readonly SlotTarget[]): PostingMode {
  return singlePostShift(cells) === null ? 'batch' : 'single';
}

/**
 * Сдвиг фазы: позиция i получает клетку, которая была у позиции i + shift. У одиночных паттернов подгонка (5г)
 * перебирает любой сдвиг, у пачек — на целые ряды.
 */
export function rotatePattern(pattern: Pattern, shift: number): Pattern {
  const q = periodLength(pattern);
  const s = ((shift % q) + q) % q;
  return { ...pattern, cells: pattern.cells.map((_, i) => cloneJson(pattern.cells[(i + s) % q] as SlotTarget)) };
}

/** Цвет цели в OKLab; без тона — серый той же L. Для образцов в интерфейсе и `Цели.png`. */
export function targetLab(target: Pick<SlotTarget, 'L' | 'hue' | 'chroma'>): Vec3 {
  if (target.hue === undefined || target.chroma === undefined) return [target.L, 0, 0];
  const rad = (target.hue * Math.PI) / 180;
  return [target.L, target.chroma * Math.cos(rad), target.chroma * Math.sin(rad)];
}
