// Патчи проекта из renderer (docs/decisions/0008-edit-flow.md). Формат — как у Immer, но core от Immer
// не зависит. Renderer может менять только коррекцию и кадр слотов: пути к оригиналам, состав
// сетки и статусы остаются за main.
import type { Project, Slot } from './types';
import { isValidAdjust, isValidCrop } from './validate';

export interface ProjectPatch {
  op: 'replace' | 'add' | 'remove';
  path: (string | number)[];
  value?: unknown;
}

export class PatchError extends Error {
  override name = 'PatchError';
}

const EDITABLE: readonly (keyof Slot)[] = ['adjust', 'crop'];

/**
 * Применяет пакет патчей к проекту на месте. Пакет атомарен: если хоть один патч запрещён
 * или оставляет коррекцию либо кадр вне пределов, проект не меняется и бросается PatchError.
 */
export function applyProjectPatches(project: Project, patches: readonly ProjectPatch[]): void {
  const touched = new Set<number>();
  for (const patch of patches) touched.add(checkPath(project, patch));

  const backup = new Map<number, Pick<Slot, 'adjust' | 'crop'>>();
  for (const index of touched) {
    const slot = project.slots[index] as Slot;
    backup.set(index, JSON.parse(JSON.stringify({ adjust: slot.adjust, crop: slot.crop })) as Pick<Slot, 'adjust' | 'crop'>);
  }

  try {
    for (const patch of patches) applyOne(project, patch);
    for (const index of touched) {
      const slot = project.slots[index] as Slot;
      if (!isValidAdjust(slot.adjust)) throw new PatchError(`некорректная коррекция слота ${slot.id}`);
      if (!isValidCrop(slot.crop)) throw new PatchError(`некорректный кадр слота ${slot.id}`);
    }
  } catch (err) {
    for (const [index, saved] of backup) Object.assign(project.slots[index] as Slot, saved);
    throw err instanceof PatchError ? err : new PatchError(err instanceof Error ? err.message : String(err));
  }
}

/** Путь вида ['slots', i, 'adjust' | 'crop', ...]. Возвращает индекс слота. */
function checkPath(project: Project, { op, path }: ProjectPatch): number {
  const [root, index, field] = path;
  const allowed =
    root === 'slots' &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < project.slots.length &&
    EDITABLE.includes(field as keyof Slot) &&
    (path.length > 3 || op === 'replace') &&
    ['replace', 'add', 'remove'].includes(op);
  if (!allowed) throw new PatchError(`патч ${op} ${JSON.stringify(path)} запрещён`);
  return index;
}

const FORBIDDEN_KEYS: readonly unknown[] = ['__proto__', 'constructor', 'prototype'];

function applyOne(project: Project, { op, path, value }: ProjectPatch): void {
  // Иначе путь через __proto__ дописал бы поле в Object.prototype, а проверка коррекции этого не заметит.
  if (path.some((key) => FORBIDDEN_KEYS.includes(key))) throw new PatchError(`патч ${JSON.stringify(path)} запрещён`);
  let parent: unknown = project;
  for (const key of path.slice(0, -1)) {
    if (!isContainer(parent) || !Object.hasOwn(parent, key)) throw new PatchError(`нет пути ${JSON.stringify(path)}`);
    parent = (parent as Record<string | number, unknown>)[key];
  }
  const key = path[path.length - 1] as string | number;
  if (!isContainer(parent)) throw new PatchError(`нет пути ${JSON.stringify(path)}`);

  if (Array.isArray(parent)) {
    if (key === 'length' && op === 'replace' && typeof value === 'number') {
      parent.length = value;
      return;
    }
    if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length) {
      throw new PatchError(`неверный индекс в ${JSON.stringify(path)}`);
    }
    if (op === 'add') parent.splice(key, 0, value);
    else if (op === 'remove') parent.splice(key, 1);
    else parent[key] = value;
    return;
  }

  const record = parent as Record<string, unknown>;
  if (op === 'remove') delete record[key];
  else record[key] = value;
}

function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
