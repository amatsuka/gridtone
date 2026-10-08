// Реестр импортированных LUT (docs/decisions/0015-lut-import.md). Копия файла лежит в luts/<id>.cube
// папки проекта; реестр меняет только main и только дописывает. Образ ссылается на запись по id.
import { LUT_SIZE_MAX, LUT_SIZE_MIN } from '../lut/lut3d';
import { createAdjust } from './defaults';
import { isRecord } from './json';
import type { Look, LutRef, Project } from './types';
import { LOOK_NAME_MAX } from './validate';

export const LUT_ID_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const REF_KEYS = ['id', 'name', 'size', 'hash', 'importedAt'];

/** id LUT — первые 16 hex-символов SHA-256 файла, как у ассетов. */
export function lutIdFromHash(hash: string): string {
  return hash.slice(0, 16);
}

/** Запись реестра под ключом key: ровно эти поля, id из хэша, размер 2…65. */
export function isValidLutRef(value: unknown, key: string): value is LutRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const { id, name, size, hash, importedAt } = value;
  return (
    keys.length === REF_KEYS.length &&
    REF_KEYS.every((k) => Object.hasOwn(value, k)) &&
    id === key &&
    typeof id === 'string' &&
    LUT_ID_RE.test(id) &&
    typeof hash === 'string' &&
    HASH_RE.test(hash) &&
    lutIdFromHash(hash) === id &&
    typeof name === 'string' &&
    name.length > 0 &&
    typeof size === 'number' &&
    Number.isInteger(size) &&
    size >= LUT_SIZE_MIN &&
    size <= LUT_SIZE_MAX &&
    typeof importedAt === 'string'
  );
}

/** Имя нового образа: TITLE из файла, иначе имя файла без `.cube`; не пустое и не длиннее LOOK_NAME_MAX. */
export function lookNameForLut(title: string | undefined, fileName: string): string {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fromTitle = title === undefined ? '' : clean(title);
  const name = fromTitle || clean(fileName.replace(/\.cube$/i, '')) || 'LUT';
  return name.slice(0, LOOK_NAME_MAX).trimEnd();
}

/**
 * Импорт в проект (только main): запись реестра, если её ещё нет, и новый образ с этим LUT — в конец
 * `looks`. Только в конец: патчи истории renderer адресуют образы по индексу (ADR 0011, 0015).
 */
export function addImportedLut(project: Project, ref: LutRef, lookId: string, name: string): Look {
  if (!project.luts[ref.id]) project.luts[ref.id] = { ...ref };
  const look: Look = { id: lookId, name, adjust: createAdjust(), importedLut: ref.id };
  project.looks.push(look);
  return look;
}

/** Запись реестра LUT образа; undefined — у образа нет LUT. */
export function lutRefOf(project: Project, look: Look): LutRef | undefined {
  return look.importedLut === undefined ? undefined : project.luts[look.importedLut];
}
