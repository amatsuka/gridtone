import type { Adjust, Crop, HueBand, Project, Pt, Slot } from './types';

export const HUE_BANDS: readonly HueBand[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];

const identityCurve = (): Pt[] => [
  [0, 0],
  [1, 1],
];

const neutralHsl = () => ({ hue: 0, sat: 0, lum: 0 });

/** Нейтральная коррекция: применение не меняет ни одного пикселя. */
export function createAdjust(): Adjust {
  return {
    exposure: 0,
    temp: 0,
    tint: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    saturation: 0,
    hsl: {
      red: neutralHsl(),
      orange: neutralHsl(),
      yellow: neutralHsl(),
      green: neutralHsl(),
      aqua: neutralHsl(),
      blue: neutralHsl(),
      purple: neutralHsl(),
      magenta: neutralHsl(),
    },
    grading: {
      shadows: { hue: 0, amount: 0 },
      midtones: { hue: 0, amount: 0 },
      highlights: { hue: 0, amount: 0 },
      balance: 0,
    },
    curves: { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
  };
}

/** Кадр по умолчанию: лента 3:4 по центру, окно сетки совпадает с ней. */
export function createCrop(): Crop {
  return {
    feed: { aspect: '3:4', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 },
    grid: { cx: 0.5, cy: 0.5 },
  };
}

/** id приходит снаружи: в core нет ни crypto из Node, ни из DOM. */
export function createSlot(id: string, assetId?: string): Slot {
  return {
    id,
    state: assetId ? 'planned' : 'empty',
    ...(assetId ? { assetId } : {}),
    postType: 'photo',
    crop: createCrop(),
    adjust: createAdjust(),
    candidates: [],
    choiceLocked: false,
  };
}

export function createProject(name: string): Project {
  return {
    version: 1,
    name,
    grid: { ratio: '3:4', columns: 3, pinned: 0 },
    assets: {},
    slots: [],
    looks: [],
  };
}
