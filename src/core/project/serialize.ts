import type { Project } from './types';

export class ProjectFormatError extends Error {
  override name = 'ProjectFormatError';
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * Разбирает project.json и проверяет структуру верхнего уровня, ассеты, образы и слоты.
 * Поля коррекции и целей пока не проверяются — их пишет только само приложение.
 */
export function parseProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('project.json повреждён: это не JSON');
  }

  if (!isRecord(data)) fail('корень не объект');
  if (data['version'] !== 1) {
    throw new ProjectFormatError(`Неподдерживаемая версия проекта: ${String(data['version'])}`);
  }
  if (typeof data['name'] !== 'string') fail('нет имени проекта');

  const grid = data['grid'];
  if (
    !isRecord(grid) ||
    !oneOf(grid['ratio'], ['3:4', '1:1']) ||
    grid['columns'] !== 3 ||
    !oneOf(grid['pinned'], [0, 1, 2, 3])
  ) {
    fail('некорректная сетка');
  }

  const assets = data['assets'];
  if (!isRecord(assets)) fail('нет списка ассетов');
  for (const [key, asset] of Object.entries(assets)) {
    if (
      !isRecord(asset) ||
      asset['id'] !== key ||
      typeof asset['path'] !== 'string' ||
      typeof asset['hash'] !== 'string' ||
      !isPositive(asset['w']) ||
      !isPositive(asset['h']) ||
      !oneOf(asset['format'], ['jpeg', 'png', 'webp', 'tiff']) ||
      !oneOf(asset['icc'], ['embedded', 'assumed-srgb']) ||
      typeof asset['importedAt'] !== 'string'
    ) {
      fail(`некорректный ассет ${key}`);
    }
  }

  const looks = data['looks'];
  if (!Array.isArray(looks)) fail('нет списка образов');
  const lookIds = new Set<string>();
  for (const look of looks) {
    if (!isRecord(look) || typeof look['id'] !== 'string' || typeof look['name'] !== 'string' || !isRecord(look['adjust'])) {
      fail('некорректный образ');
    }
    if (lookIds.has(look['id'])) fail(`повторяется образ ${look['id']}`);
    lookIds.add(look['id']);
  }

  const slots = data['slots'];
  if (!Array.isArray(slots)) fail('нет списка слотов');
  const slotIds = new Set<string>();
  for (const slot of slots) {
    if (!isRecord(slot) || typeof slot['id'] !== 'string') fail('слот без id');
    const id = slot['id'];
    if (slotIds.has(id)) fail(`повторяется слот ${id}`);
    slotIds.add(id);
    if (
      !oneOf(slot['state'], ['published', 'planned', 'empty']) ||
      !oneOf(slot['postType'], ['photo', 'carousel', 'reels']) ||
      !isRecord(slot['crop']) ||
      !isRecord(slot['adjust']) ||
      !Array.isArray(slot['candidates']) ||
      typeof slot['choiceLocked'] !== 'boolean'
    ) {
      fail(`некорректный слот ${id}`);
    }
    const assetId = slot['assetId'];
    if (assetId !== undefined && (typeof assetId !== 'string' || !(assetId in assets))) {
      fail(`слот ${id} ссылается на неизвестный ассет`);
    }
    const lookId = slot['lookId'];
    if (lookId !== undefined && (typeof lookId !== 'string' || !lookIds.has(lookId))) {
      fail(`слот ${id} ссылается на неизвестный образ`);
    }
  }

  return data as unknown as Project;
}

function fail(reason: string): never {
  throw new ProjectFormatError(`project.json повреждён: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T>(value: unknown, options: readonly T[]): value is T {
  return options.includes(value as T);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
