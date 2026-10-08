// Патчи проекта из renderer (docs/decisions/0008-edit-flow.md). Формат — как у Immer, но core от Immer
// не зависит. Проверяется не путь, а результат пакета (docs/decisions/0010-patch-invariants.md):
// renderer переставляет слоты, правит их коррекцию, кадр и образ, создаёт и удаляет образы, назначает
// и снимает LUT из реестра (docs/decisions/0015-lut-import.md). Оригиналы, состав сетки, статусы и сам
// реестр LUT остаются за main.
import { cloneJson, isRecord, sameJson, sameJsonExcept } from './json';
import type { Look, Project, Slot } from './types';
import { isValidAdjust, isValidCrop, isValidLook } from './validate';

export interface ProjectPatch {
  op: 'replace' | 'add' | 'remove';
  path: (string | number)[];
  value?: unknown;
}

export class PatchError extends Error {
  override name = 'PatchError';
}

/** Поля слота, которые меняет renderer. Остальные после пакета должны остаться прежними. */
const EDITABLE_SLOT_FIELDS: readonly string[] = ['adjust', 'crop', 'lookId'];
const ROOTS: readonly unknown[] = ['slots', 'looks'];
const OPS: readonly unknown[] = ['replace', 'add', 'remove'];
const FORBIDDEN_KEYS: readonly unknown[] = ['__proto__', 'constructor', 'prototype'];

/** Части проекта, которые трогают патчи. После пакета — непроверенные значения. */
interface Draft {
  slots: unknown;
  looks: unknown;
}

/**
 * Применяет пакет патчей к проекту. Пакет атомарен: он применяется к копии слотов и образов,
 * и если результат нарушает хоть один инвариант, проект не меняется и бросается PatchError.
 */
export function applyProjectPatches(project: Project, patches: readonly ProjectPatch[]): void {
  for (const patch of patches) checkPath(patch);
  const touches = (root: string) => patches.some((patch) => patch.path[0] === root);
  const draft: Draft = {
    slots: touches('slots') ? cloneJson(project.slots) : project.slots,
    looks: touches('looks') ? cloneJson(project.looks) : project.looks,
  };
  try {
    for (const patch of patches) applyOne(draft, patch);
  } catch (err) {
    throw err instanceof PatchError ? err : new PatchError(err instanceof Error ? err.message : String(err));
  }
  const { slots, looks } = checkInvariants(project, draft);
  project.slots = slots;
  project.looks = looks;
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

/** Инварианты ADR 0010. Проверяется только изменившееся: старое значение не блокирует новые правки. */
function checkInvariants(before: Project, after: Draft): { slots: Slot[]; looks: Look[] } {
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

  const slotsBefore = new Map(before.slots.map((slot) => [slot.id, slot]));
  if (!Array.isArray(after.slots) || after.slots.length !== before.slots.length) {
    throw new PatchError('состав сетки меняет только main');
  }
  const seen = new Set<string>();
  for (const slot of after.slots as unknown[]) {
    const id = isRecord(slot) ? slot['id'] : undefined;
    const prev = typeof id === 'string' ? slotsBefore.get(id) : undefined;
    if (!isRecord(slot) || !prev || seen.has(prev.id)) throw new PatchError('состав сетки меняет только main');
    seen.add(prev.id);
    if (!sameJsonExcept(prev as unknown as Record<string, unknown>, slot, EDITABLE_SLOT_FIELDS)) {
      throw new PatchError(`у слота ${prev.id} renderer меняет только коррекцию, кадр и образ`);
    }
    if (!sameJson(prev.adjust, slot['adjust']) && !isValidAdjust(slot['adjust'])) {
      throw new PatchError(`некорректная коррекция слота ${prev.id}`);
    }
    if (!sameJson(prev.crop, slot['crop']) && !isValidCrop(slot['crop'])) {
      throw new PatchError(`некорректный кадр слота ${prev.id}`);
    }
    // У всех слотов, а не только изменённых: удаление образа, на который ссылаются, тоже ловится здесь.
    const lookId = slot['lookId'];
    if (Object.hasOwn(slot, 'lookId') && !(typeof lookId === 'string' && lookIds.has(lookId))) {
      throw new PatchError(`слот ${prev.id} ссылается на неизвестный образ`);
    }
  }
  return { slots: after.slots as Slot[], looks: after.looks as Look[] };
}
