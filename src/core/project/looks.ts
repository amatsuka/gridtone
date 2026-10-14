// Образы проекта (docs/spec.md, «Коррекция в два уровня»): создание, копия, удаление, назначение плиткам.
// Функции меняют проект на месте — в renderer это черновик Immer. id приходят снаружи, как в createSlot.
import { createAdjust } from './defaults';
import { cloneJson } from './json';
import type { Adjust, Look, Project } from './types';
import { LOOK_NAME_MAX } from './validate';

/** Нейтральный образ или образ с копией данной коррекции. */
export function createLook(id: string, name: string, adjust?: Adjust): Look {
  return { id, name, adjust: adjust ? cloneJson(adjust) : createAdjust() };
}

/** «Образ N» с наименьшим свободным N. */
export function nextLookName(looks: readonly Look[]): string {
  const taken = new Set(looks.map((look) => look.name));
  for (let n = 1; ; n++) {
    const name = `Образ ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Копия встаёт сразу после оригинала, со ссылкой на тот же LUT из реестра (ADR 0015). */
export function duplicateLook(project: Project, lookId: string, newId: string): Look | undefined {
  const index = project.looks.findIndex((look) => look.id === lookId);
  const source = project.looks[index];
  if (!source) return undefined;
  const copy = createLook(newId, copyName(project.looks, source.name), source.adjust);
  if (source.importedLut !== undefined) copy.importedLut = source.importedLut;
  project.looks.splice(index + 1, 0, copy);
  return copy;
}

/** Удаляет образ и снимает его с плиток: висячую ссылку main не примет. */
export function removeLook(project: Project, lookId: string): void {
  const index = project.looks.findIndex((look) => look.id === lookId);
  if (index < 0) return;
  project.looks.splice(index, 1);
  for (const slot of project.slots) {
    if (slot.lookId === lookId) delete slot.lookId;
  }
}

/**
 * Назначает образ слотам; null снимает. Опубликованные посты не перекрашиваются, у пустых позиций образа нет
 * (docs/decisions/0022-statuses-empty-pinned.md).
 */
export function assignLook(project: Project, slotIds: Iterable<string>, lookId: string | null): void {
  if (lookId !== null && !project.looks.some((look) => look.id === lookId)) return;
  const ids = new Set(slotIds);
  for (const slot of project.slots) {
    if (!ids.has(slot.id) || slot.state === 'published' || slot.assetId === undefined) continue;
    if (lookId === null) {
      if ('lookId' in slot) delete slot.lookId;
    } else if (slot.lookId !== lookId) {
      slot.lookId = lookId;
    }
  }
}

export function lookUsage(project: Project, lookId: string): number {
  return project.slots.filter((slot) => slot.lookId === lookId).length;
}

/** «Имя копия», «Имя копия 2»… Основа обрезается, чтобы имя не вышло за LOOK_NAME_MAX. */
function copyName(looks: readonly Look[], name: string): string {
  const taken = new Set(looks.map((look) => look.name));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' копия' : ` копия ${n}`;
    const candidate = `${name.slice(0, LOOK_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
