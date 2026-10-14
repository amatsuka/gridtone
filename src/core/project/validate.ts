// Проверка коррекции, кадра, образов, сетки, id новых слотов, целей и паттерна: они приходят из renderer патчами
// и должны оставаться в своих пределах. Согласованность целей с паттерном и режим публикации — patch.ts
// (docs/decisions/0023-patterns.md).
import { PATTERN_COLUMNS, PATTERN_MAX_ROWS } from '../pattern/pattern';
import { HUE_BANDS } from './defaults';
import { isRecord } from './json';
import type { Adjust, Crop, Look, Pattern, Project, Pt, SlotTarget } from './types';

const SLIDERS_100 = ['temp', 'tint', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] as const;
const FEED_ASPECTS: readonly unknown[] = ['4:5', '3:4', '1:1'];

// Состав полей строгий: лишнее поле из renderer иначе молча уехало бы в project.json.
const ADJUST_KEYS = ['exposure', ...SLIDERS_100, 'hsl', 'grading', 'curves'];
const HSL_KEYS = ['hue', 'sat', 'lum'];
const GRADING_KEYS = ['shadows', 'midtones', 'highlights', 'balance'];
const WHEEL_KEYS = ['hue', 'amount'];
const CURVES_KEYS = ['master', 'r', 'g', 'b'];
const FEED_KEYS = ['aspect', 'cx', 'cy', 'zoom', 'angle'];
const GRID_KEYS = ['cx', 'cy'];
const LOOK_KEYS = ['id', 'name', 'adjust'];
const GRID_SETTINGS_KEYS = ['ratio', 'columns', 'pinned'];
const TARGET_KEYS = ['L', 'tolerance', 'hard'];
const TARGET_OPTIONAL_KEYS = ['hue', 'chroma', 'palette'];
const TOLERANCE_KEYS = ['L', 'hue', 'chroma'];
const PATTERN_KEYS = ['source', 'periodRows', 'postingMode', 'cells'];
const PATTERN_SOURCES: readonly unknown[] = ['generator', 'string', 'image', 'reference'];
const POSTING_MODES: readonly unknown[] = ['single', 'batch'];

export const LOOK_NAME_MAX = 100;
/** id нового слота из renderer — непустая строка не длиннее (renderer даёт UUID). */
export const SLOT_ID_MAX = 100;
/** Закреплённых постов — не больше (spec, «Модель данных»: pinned 0–3). */
export const PINNED_MAX = 3;
/** Пределы ползунков: экспозиция −EXPOSURE_MAX…EXPOSURE_MAX EV, остальные и тон HSL — −SLIDER_MAX…SLIDER_MAX. */
export const EXPOSURE_MAX = 3;
export const SLIDER_MAX = 100;
/** Кадр: увеличение 1…CROP_ZOOM_MAX, поворот −CROP_ANGLE_MAX…CROP_ANGLE_MAX градусов. */
export const CROP_ZOOM_MAX = 10;
export const CROP_ANGLE_MAX = 45;
/** Точек в одной кривой — не больше. */
export const CURVE_MAX_POINTS = 16;
/** Хрома цели и её допуск — не больше: дальше охвата sRGB. */
export const TARGET_CHROMA_MAX = 0.5;
/** Цветов в палитре цели — не больше (палитра — этапы 6–7). */
export const TARGET_PALETTE_MAX = 16;

export function isValidAdjust(value: unknown): value is Adjust {
  if (!hasKeys(value, ADJUST_KEYS)) return false;
  if (!inRange(value['exposure'], -EXPOSURE_MAX, EXPOSURE_MAX)) return false;
  if (!SLIDERS_100.every((key) => inRange(value[key], -SLIDER_MAX, SLIDER_MAX))) return false;

  const hsl = value['hsl'];
  if (!hasKeys(hsl, HUE_BANDS)) return false;
  for (const band of HUE_BANDS) {
    const b = hsl[band];
    if (!hasKeys(b, HSL_KEYS) || !HSL_KEYS.every((key) => inRange(b[key], -SLIDER_MAX, SLIDER_MAX))) return false;
  }

  const grading = value['grading'];
  if (!hasKeys(grading, GRADING_KEYS) || !inRange(grading['balance'], -100, 100)) return false;
  for (const key of ['shadows', 'midtones', 'highlights']) {
    const wheel = grading[key];
    if (!hasKeys(wheel, WHEEL_KEYS) || !inRange(wheel['hue'], 0, 360) || !inRange(wheel['amount'], 0, 100)) return false;
  }

  const curves = value['curves'];
  return hasKeys(curves, CURVES_KEYS) && CURVES_KEYS.every((key) => isCurve(curves[key]));
}

export function isValidCrop(value: unknown): value is Crop {
  if (!hasKeys(value, ['feed', 'grid'])) return false;
  const { feed, grid } = value;
  return (
    hasKeys(feed, FEED_KEYS) &&
    FEED_ASPECTS.includes(feed['aspect']) &&
    inRange(feed['cx'], 0, 1) &&
    inRange(feed['cy'], 0, 1) &&
    inRange(feed['zoom'], 1, CROP_ZOOM_MAX) &&
    inRange(feed['angle'], -CROP_ANGLE_MAX, CROP_ANGLE_MAX) &&
    hasKeys(grid, GRID_KEYS) &&
    inRange(grid['cx'], 0, 1) &&
    inRange(grid['cy'], 0, 1)
  );
}

/** Образ — ровно { id, name, adjust } и, возможно, importedLut. */
export function isValidLook(value: unknown): value is Look {
  if (!isRecord(value)) return false;
  const withLut = Object.hasOwn(value, 'importedLut');
  return (
    hasKeys(value, withLut ? [...LOOK_KEYS, 'importedLut'] : LOOK_KEYS) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    value['id'].length <= LOOK_NAME_MAX &&
    isValidLookName(value['name']) &&
    isValidAdjust(value['adjust']) &&
    (!withLut || typeof value['importedLut'] === 'string')
  );
}

/**
 * Настройки сетки после правки renderer (docs/decisions/0022-statuses-empty-pinned.md): renderer меняет только
 * число закреплённых — целое 0…PINNED_MAX; пропорции и число колонок прежние, лишних полей нет.
 */
export function isValidGridChange(before: Project['grid'], after: unknown): after is Project['grid'] {
  return (
    hasKeys(after, GRID_SETTINGS_KEYS) &&
    after['ratio'] === before.ratio &&
    after['columns'] === before.columns &&
    Number.isInteger(after['pinned']) &&
    inRange(after['pinned'], 0, PINNED_MAX)
  );
}

/**
 * Цель позиции (ADR 0023): L 0..1, тон 0..360 и хрома — по желанию, допуски L, тона и хромы, жёсткая или мягкая;
 * палитра — список OKLab. Лишних полей нет.
 */
export function isValidTarget(value: unknown): value is SlotTarget {
  if (!isRecord(value)) return false;
  const keys = [...TARGET_KEYS, ...TARGET_OPTIONAL_KEYS.filter((key) => Object.hasOwn(value, key))];
  if (!hasKeys(value, keys)) return false;
  const { tolerance } = value;
  return (
    inRange(value['L'], 0, 1) &&
    (!Object.hasOwn(value, 'hue') || (inRange(value['hue'], 0, 360) && value['hue'] < 360)) &&
    (!Object.hasOwn(value, 'chroma') || inRange(value['chroma'], 0, TARGET_CHROMA_MAX)) &&
    (!Object.hasOwn(value, 'palette') || isPalette(value['palette'])) &&
    typeof value['hard'] === 'boolean' &&
    hasKeys(tolerance, TOLERANCE_KEYS) &&
    inRange(tolerance['L'], 0, 1) &&
    inRange(tolerance['hue'], 0, 180) &&
    inRange(tolerance['chroma'], 0, TARGET_CHROMA_MAX)
  );
}

/**
 * Форма паттерна (ADR 0023): источник, период 1…PATTERN_MAX_ROWS рядов, режим публикации, клетки периода —
 * ровно 3 · periodRows целей. Что режим публикации равен вычисленному, проверяет patch.ts.
 */
export function isValidPattern(value: unknown): value is Pattern {
  if (!hasKeys(value, PATTERN_KEYS)) return false;
  const { periodRows, cells } = value;
  return (
    PATTERN_SOURCES.includes(value['source']) &&
    POSTING_MODES.includes(value['postingMode']) &&
    Number.isInteger(periodRows) &&
    inRange(periodRows, 1, PATTERN_MAX_ROWS) &&
    Array.isArray(cells) &&
    cells.length === PATTERN_COLUMNS * periodRows &&
    cells.every(isValidTarget)
  );
}

export function isValidSlotId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SLOT_ID_MAX;
}

/** Имя образа: не пустое и не из одних пробелов, не длиннее LOOK_NAME_MAX. */
export function isValidLookName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= LOOK_NAME_MAX;
}

/** Кривая — от 2 до CURVE_MAX_POINTS точек, координаты в 0..1, x строго растёт. */
function isCurve(value: unknown): value is Pt[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > CURVE_MAX_POINTS) return false;
  let prevX = -Infinity;
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2 || !inRange(p[0], 0, 1) || !inRange(p[1], 0, 1) || p[0] <= prevX) return false;
    prevX = p[0];
  }
  return true;
}

function isPalette(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= TARGET_PALETTE_MAX &&
    value.every((lab) => Array.isArray(lab) && lab.length === 3 && lab.every((x) => typeof x === 'number' && Number.isFinite(x)))
  );
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Объект ровно с этими собственными полями. */
function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
