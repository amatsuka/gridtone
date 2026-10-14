// Патчи проекта из renderer (docs/decisions/0008-edit-flow.md). Формат — как у Immer, но core от Immer
// не зависит. Проверяется не путь, а результат пакета (docs/decisions/0010-patch-invariants.md):
// renderer переставляет слоты, правит их коррекцию, кадр и образ, создаёт и удаляет образы, назначает
// и снимает LUT из реестра (docs/decisions/0015-lut-import.md), ставит статус «опубликован», вставляет и
// удаляет пустые позиции и меняет число закреплённых (docs/decisions/0022-statuses-empty-pinned.md),
// пишет паттерн и цели позиций (docs/decisions/0023-patterns.md). Оригиналы, фото в позициях и сам реестр LUT
// остаются за main.
import { postingModeOf, targetsAgree } from '../pattern/pattern';
import { createSlot } from './defaults';
import { cloneJson, isRecord, sameJson, sameJsonExcept } from './json';
import type { Look, Pattern, Project, Slot } from './types';
import { isValidAdjust, isValidCrop, isValidGridChange, isValidLook, isValidPattern, isValidSlotId, isValidTarget } from './validate';

export interface ProjectPatch {
  op: 'replace' | 'add' | 'remove';
  path: (string | number)[];
  value?: unknown;
}

export class PatchError extends Error {
  override name = 'PatchError';
}

/** Поля слота, которые меняет renderer. Остальные после пакета должны остаться прежними. */
const EDITABLE_SLOT_FIELDS: readonly string[] = ['adjust', 'crop', 'lookId', 'state', 'target'];
const ROOTS: readonly unknown[] = ['slots', 'looks', 'grid', 'pattern'];
/** Статусы позиции с фото: renderer переключает только их (ADR 0022). */
const PHOTO_STATES: readonly unknown[] = ['planned', 'published'];
const OPS: readonly unknown[] = ['replace', 'add', 'remove'];
const FORBIDDEN_KEYS: readonly unknown[] = ['__proto__', 'constructor', 'prototype'];

/** Части проекта, которые трогают патчи. После пакета — непроверенные значения. */
interface Draft {
  slots: unknown;
  looks: unknown;
  grid: unknown;
  pattern: unknown;
}

/**
 * Применяет пакет патчей к проекту. Пакет атомарен: он применяется к копии слотов, образов и настроек
 * сетки, и если результат нарушает хоть один инвариант, проект не меняется и бросается PatchError.
 */
export function applyProjectPatches(project: Project, patches: readonly ProjectPatch[]): void {
  for (const patch of patches) checkPath(patch);
  const touches = (root: string) => patches.some((patch) => patch.path[0] === root);
  const draft: Draft = {
    slots: touches('slots') ? cloneJson(project.slots) : project.slots,
    looks: touches('looks') ? cloneJson(project.looks) : project.looks,
    grid: touches('grid') ? cloneJson(project.grid) : project.grid,
    pattern: touches('pattern') && project.pattern !== undefined ? cloneJson(project.pattern) : project.pattern,
  };
  try {
    for (const patch of patches) applyOne(draft, patch);
  } catch (err) {
    throw err instanceof PatchError ? err : new PatchError(err instanceof Error ? err.message : String(err));
  }
  const { slots, looks, grid, pattern } = checkInvariants(project, draft);
  project.slots = slots;
  project.looks = looks;
  project.grid = grid;
  if (pattern) project.pattern = pattern;
  else delete project.pattern;
}

function checkPath({ op, path }: ProjectPatch): void {
  // Иначе путь через __proto__ дописал бы поле в Object.prototype, а проверка результата этого не заметит.
  if (!OPS.includes(op) || !ROOTS.includes(path[0]) || path.some((key) => FORBIDDEN_KEYS.includes(key))) {
    throw new PatchError(`патч ${op} ${JSON.stringify(path)} запрещён`);
  }
}

function applyOne(draft: Draft, { op, path, value }: ProjectPatch): void {
  let parent: unknown = draft;
  for (const key of path.slice(0, -1)) {
    if (!hasChild(parent, key)) throw new PatchError(`нет пути ${JSON.stringify(path)}`);
    parent = (parent as Record<string | number, unknown>)[key];
  }
  const key = path[path.length - 1] as string | number;

  if (Array.isArray(parent)) {
    if (key === 'length' && op === 'replace') {
      if (!isIndex(value) || value > parent.length) throw new PatchError(`неверная длина в ${JSON.stringify(path)}`);
      parent.length = value;
      return;
    }
    const limit = op === 'add' ? parent.length : parent.length - 1;
    if (!isIndex(key) || key > limit) throw new PatchError(`неверный индекс в ${JSON.stringify(path)}`);
    if (op === 'add') parent.splice(key, 0, value);
    else if (op === 'remove') parent.splice(key, 1);
    else parent[key] = value;
    return;
  }

  if (!isRecord(parent) || typeof key !== 'string') throw new PatchError(`нет пути ${JSON.stringify(path)}`);
  if (op === 'remove') delete parent[key];
  else parent[key] = value;
}

/** Массив — только по числовому индексу, объект — только по собственному ключу. */
function hasChild(parent: unknown, key: string | number): boolean {
  if (Array.isArray(parent)) return isIndex(key) && key < parent.length;
  return isRecord(parent) && typeof key === 'string' && Object.hasOwn(parent, key);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

interface Checked {
  slots: Slot[];
  looks: Look[];
  grid: Project['grid'];
  pattern: Pattern | undefined;
}

/** Инварианты ADR 0010, 0022 и 0023. Проверяется только изменившееся: старое значение не блокирует новые правки. */
function checkInvariants(before: Project, after: Draft): Checked {
  if (after.grid !== before.grid && !isValidGridChange(before.grid, after.grid)) {
    throw new PatchError('в настройках сетки renderer меняет только число закреплённых, 0–3');
  }
  const patternChanged = !sameJson(before.pattern, after.pattern);
  if (patternChanged && after.pattern !== undefined) {
    if (!isValidPattern(after.pattern)) throw new PatchError('некорректный паттерн');
    // Режим публикации считает core при записи паттерна: renderer не может его объявить.
    if (after.pattern.postingMode !== postingModeOf(after.pattern.cells)) {
      throw new PatchError('режим публикации паттерна не совпадает с вычисленным');
    }
  }

  if (!Array.isArray(after.looks)) throw new PatchError('список образов должен быть массивом');
  const lookIds = new Set<string>();
  const looksBefore = new Map(before.looks.map((look) => [look.id, look]));
  for (const look of after.looks as unknown[]) {
    if (!isRecord(look) || typeof look['id'] !== 'string') throw new PatchError('образ без id');
    const id = look['id'];
    if (lookIds.has(id)) throw new PatchError(`повторяется образ ${id}`);
    lookIds.add(id);
    const prev = looksBefore.get(id);
    if (prev && sameJson(prev, look)) continue;
    if (!isValidLook(look)) throw new PatchError(`некорректный образ ${id}`);
    // Назначить и снять можно только LUT из реестра: сам реестр корнем патча быть не может.
    if (look.importedLut !== undefined && !Object.hasOwn(before.luts, look.importedLut)) {
      throw new PatchError(`образ ${id} ссылается на неизвестный LUT`);
    }
  }

  if (!Array.isArray(after.slots)) throw new PatchError('список слотов должен быть массивом');
  const slotsBefore = new Map(before.slots.map((slot) => [slot.id, slot]));
  const seen = new Set<string>();
  let targetsChanged = false;
  for (const slot of after.slots as unknown[]) {
    const id = isRecord(slot) ? slot['id'] : undefined;
    if (!isRecord(slot) || typeof id !== 'string') throw new PatchError('слот без id');
    if (seen.has(id)) throw new PatchError(`повторяется слот ${id}`);
    seen.add(id);
    const prev = slotsBefore.get(id);
    if (!prev) {
      // Новый слот — только пустая позиция со значениями по умолчанию, кроме цели своей позиции: фото ставит main.
      if (!isValidSlotId(id) || !sameJsonExcept(slot, createSlot(id) as unknown as Record<string, unknown>, ['target'])) {
        throw new PatchError(`новый слот ${id}: renderer добавляет только пустую позицию по умолчанию`);
      }
      if (Object.hasOwn(slot, 'target') && !isValidTarget(slot['target'])) throw new PatchError(`некорректная цель слота ${id}`);
      targetsChanged = true;
      continue;
    }
    if (!sameJsonExcept(prev as unknown as Record<string, unknown>, slot, EDITABLE_SLOT_FIELDS)) {
      throw new PatchError(`у слота ${id} renderer меняет только коррекцию, кадр, образ, статус и цель`);
    }
    // Цель — свойство позиции (ADR 0023): у любой позиции, в том числе опубликованной и пустой, она следует паттерну.
    const targetChanged = !sameJson(prev.target, slot['target']);
    const hasTarget = Object.hasOwn(slot, 'target');
    if (hasTarget && (targetChanged || slot['target'] === undefined) && !isValidTarget(slot['target'])) {
      throw new PatchError(`некорректная цель слота ${id}`);
    }
    if (targetChanged) targetsChanged = true;
    checkSlotState(prev, slot);
    // Опубликованный пост и пустая позиция не правятся: статус переключается отдельной правкой.
    const fixed = prev.assetId === undefined || prev.state === 'published' || slot['state'] === 'published';
    const adjustChanged = !sameJson(prev.adjust, slot['adjust']);
    const cropChanged = !sameJson(prev.crop, slot['crop']);
    if (fixed && (adjustChanged || cropChanged)) {
      throw new PatchError(`слот ${id} опубликован или пуст: коррекция и кадр не меняются`);
    }
    if (adjustChanged && !isValidAdjust(slot['adjust'])) throw new PatchError(`некорректная коррекция слота ${id}`);
    if (cropChanged && !isValidCrop(slot['crop'])) throw new PatchError(`некорректный кадр слота ${id}`);
    // У всех слотов, а не только изменённых: удаление образа, на который ссылаются, тоже ловится здесь.
    const lookId = slot['lookId'];
    if (Object.hasOwn(slot, 'lookId') && !(typeof lookId === 'string' && lookIds.has(lookId))) {
      throw new PatchError(`слот ${id} ссылается на неизвестный образ`);
    }
    if (fixed && lookId !== prev.lookId && !followsLook(prev.lookId, lookId as string | undefined, lookIds, looksBefore)) {
      throw new PatchError(`слот ${id} опубликован или пуст: образ уходит и возвращается только вместе с самим образом`);
    }
  }
  for (const prev of before.slots) {
    if (!seen.has(prev.id) && prev.assetId !== undefined) throw new PatchError(`фото из сетки убирает только main (слот ${prev.id})`);
  }
  const slots = after.slots as Slot[];
  const grid = after.grid as Project['grid'];
  const pattern = after.pattern as Pattern | undefined;
  // Цели — проекция паттерна на позиции: после всего, что их сдвигает, они обязаны совпасть с ним (ADR 0023).
  const orderChanged = slots.length !== before.slots.length || slots.some((slot, i) => slot.id !== before.slots[i]?.id);
  const moved = patternChanged || grid.pinned !== before.grid.pinned || orderChanged || targetsChanged;
  if (pattern && moved && !targetsAgree(slots, pattern, grid.pinned)) {
    throw new PatchError('цели позиций не согласованы с паттерном');
  }
  return { slots, looks: after.looks as Look[], grid, pattern };
}

/** Статус: renderer переключает «запланирован» ↔ «опубликован» только у позиции с фото. */
function checkSlotState(prev: Slot, slot: Record<string, unknown>): void {
  const state = slot['state'];
  if (state === prev.state) return;
  if (prev.assetId === undefined || !PHOTO_STATES.includes(prev.state) || !PHOTO_STATES.includes(state)) {
    throw new PatchError(`статус слота ${prev.id}: только «запланирован» ↔ «опубликован» у позиции с фото`);
  }
}

/**
 * Образ опубликованного поста или пустой позиции меняется только вслед за самим образом: снимается вместе
 * с удалением образа и возвращается вместе с ним — отменой удаления.
 */
function followsLook(prev: string | undefined, next: string | undefined, lookIds: ReadonlySet<string>, looksBefore: ReadonlyMap<string, Look>): boolean {
  if (prev !== undefined && next === undefined) return !lookIds.has(prev);
  if (prev === undefined && next !== undefined) return !looksBefore.has(next);
  return false;
}
