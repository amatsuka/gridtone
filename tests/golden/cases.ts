// Наборы параметров для сверки конвейеров: каждый шаг отдельно, крайние значения, всё вместе и случайные.
import type { PipelineParams } from '../../src/core/color/bake';
import { createAdjust, HUE_BANDS } from '../../src/core/project/defaults';
import type { Adjust } from '../../src/core/project/types';
import { seededRandom } from '../core/color/helpers';

function adjust(patch: Partial<Adjust> = {}): Adjust {
  return { ...createAdjust(), ...patch };
}

/** Случайная коррекция во всём диапазоне ползунков, включая кривые, HSL и круги. */
export function randomAdjust(random: () => number): Adjust {
  const s = () => Math.round(random() * 200 - 100);
  const a = adjust({
    exposure: random() * 6 - 3,
    temp: s(),
    tint: s(),
    contrast: s(),
    highlights: s(),
    shadows: s(),
    whites: s(),
    blacks: s(),
    vibrance: s(),
    saturation: s(),
  });
  for (const band of HUE_BANDS) a.hsl[band] = { hue: s(), sat: s(), lum: s() };
  a.grading = {
    shadows: { hue: random() * 360, amount: random() * 100 },
    midtones: { hue: random() * 360, amount: random() * 100 },
    highlights: { hue: random() * 360, amount: random() * 100 },
    balance: s(),
  };
  a.curves.master = [
    [0, random() * 0.2],
    [0.5, 0.3 + random() * 0.4],
    [1, 0.8 + random() * 0.2],
  ];
  a.curves.g = [
    [0, 0],
    [0.4, random()],
    [1, 1],
  ];
  return a;
}

function curves(): Adjust {
  const a = adjust();
  a.curves.master = [
    [0, 0.04],
    [0.25, 0.2],
    [0.75, 0.82],
    [1, 0.97],
  ];
  a.curves.r = [
    [0, 0.05],
    [0.5, 0.55],
    [1, 1],
  ];
  a.curves.b = [
    [0, 0],
    [0.3, 0.38],
    [0.6, 0.58],
    [1, 0.9],
  ];
  return a;
}

function hsl(): Adjust {
  const a = adjust();
  a.hsl.orange = { hue: -20, sat: -30, lum: 25 };
  a.hsl.blue = { hue: 40, sat: 60, lum: -70 };
  a.hsl.green = { hue: 100, sat: -100, lum: 0 };
  a.hsl.magenta = { hue: -100, sat: 100, lum: 100 };
  return a;
}

function grading(): Adjust {
  return adjust({
    grading: {
      shadows: { hue: 200, amount: 60 },
      midtones: { hue: 330, amount: 20 },
      highlights: { hue: 70, amount: 45 },
      balance: 30,
    },
  });
}

export interface ParityCase {
  name: string;
  params: PipelineParams;
}

export function parityCases(): ParityCase[] {
  const random = seededRandom(77);
  const everything = adjust({
    exposure: 0.4,
    temp: 25,
    tint: -10,
    contrast: 30,
    highlights: -45,
    shadows: 35,
    whites: 15,
    blacks: -20,
    vibrance: 40,
    saturation: -15,
    hsl: hsl().hsl,
    grading: grading().grading,
    curves: curves().curves,
  });
  return [
    { name: 'нейтрально', params: { photo: adjust() } },
    { name: 'экспозиция +1.5', params: { photo: adjust({ exposure: 1.5 }) } },
    { name: 'экспозиция −2', params: { photo: adjust({ exposure: -2 }) } },
    { name: 'тепло и пурпур', params: { photo: adjust({ temp: 60, tint: 40 }) } },
    { name: 'холод и зелень', params: { photo: adjust({ temp: -100, tint: -100 }) } },
    { name: 'контраст +100', params: { photo: adjust({ contrast: 100 }) } },
    { name: 'контраст −100', params: { photo: adjust({ contrast: -100 }) } },
    { name: 'света −100, тени +100', params: { photo: adjust({ highlights: -100, shadows: 100 }) } },
    { name: 'белые +100, чёрные −100', params: { photo: adjust({ whites: 100, blacks: -100 }) } },
    {
      name: 'тон и экспозиция',
      params: { photo: adjust({ exposure: 0.7, contrast: 40, highlights: -60, shadows: 50, whites: 20, blacks: -30 }) },
    },
    { name: 'кривые', params: { photo: curves() } },
    { name: 'HSL', params: { photo: hsl() } },
    { name: 'круги', params: { photo: grading() } },
    { name: 'сочность +80, насыщенность −30', params: { photo: adjust({ vibrance: 80, saturation: -30 }) } },
    { name: 'насыщенность +100', params: { photo: adjust({ saturation: 100 }) } },
    { name: 'всё сразу и образ', params: { photo: everything, look: adjust({ temp: -15, contrast: 20, vibrance: -20 }) } },
    { name: 'случайно 1', params: { photo: randomAdjust(random), look: randomAdjust(random) } },
    { name: 'случайно 2', params: { photo: randomAdjust(random), look: randomAdjust(random) } },
    { name: 'случайно 3', params: { photo: randomAdjust(random) } },
  ];
}
