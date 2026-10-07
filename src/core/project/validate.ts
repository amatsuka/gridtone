// Проверка коррекции, кадра и образов: они приходят из renderer патчами и должны оставаться в своих пределах.
import { HUE_BANDS } from './defaults';
import { isRecord } from './json';
import type { Adjust, Crop, Look, Pt } from './types';

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

export const LOOK_NAME_MAX = 100;

export function isValidAdjust(value: unknown): value is Adjust {
  if (!hasKeys(value, ADJUST_KEYS)) return false;
  if (!inRange(value['exposure'], -3, 3)) return false;
  if (!SLIDERS_100.every((key) => inRange(value[key], -100, 100))) return false;

  const hsl = value['hsl'];
  if (!hasKeys(hsl, HUE_BANDS)) return false;
  for (const band of HUE_BANDS) {
    const b = hsl[band];
    if (!hasKeys(b, HSL_KEYS) || !inRange(b['hue'], -100, 100) || !inRange(b['sat'], -100, 100) || !inRange(b['lum'], -100, 100))
      return false;
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
    inRange(feed['zoom'], 1, 10) &&
    inRange(feed['angle'], -45, 45) &&
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

/** Имя образа: не пустое и не из одних пробелов, не длиннее LOOK_NAME_MAX. */
export function isValidLookName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= LOOK_NAME_MAX;
}

/** Кривая — не меньше двух точек, координаты в 0..1. */
function isCurve(value: unknown): value is Pt[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((p) => Array.isArray(p) && p.length === 2 && inRange(p[0], 0, 1) && inRange(p[1], 0, 1))
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
