// Группы правок для копирования и синхронизации между плитками — как Copy Settings в Lightroom.
import { cloneJson } from './json';
import type { Adjust } from './types';

export type AdjustGroup = 'whiteBalance' | 'tone' | 'presence' | 'hsl' | 'grading' | 'curves';

/** Поля коррекции по группам; каждое поле ровно в одной группе. Порядок — как в инспекторе. */
export const ADJUST_GROUPS: Readonly<Record<AdjustGroup, readonly (keyof Adjust)[]>> = {
  whiteBalance: ['temp', 'tint'],
  tone: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  presence: ['vibrance', 'saturation'],
  hsl: ['hsl'],
  grading: ['grading'],
  curves: ['curves'],
};

export const ADJUST_GROUP_IDS = Object.keys(ADJUST_GROUPS) as AdjustGroup[];

/** Переносит выбранные группы из source в target на месте. Копиями: общих объектов не остаётся. */
export function copyAdjustGroups(target: Adjust, source: Adjust, groups: Iterable<AdjustGroup>): void {
  for (const group of groups) {
    for (const key of ADJUST_GROUPS[group]) copyField(target, source, key);
  }
}

function copyField<K extends keyof Adjust>(target: Adjust, source: Adjust, key: K): void {
  target[key] = cloneJson(source[key]);
}
