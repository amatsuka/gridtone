// Поправки выбросов (docs/spec.md, «Выбросы и исправления»; docs/decisions/0021-fixes.md). У причины выброса —
// один ползунок поправки фото: яркость — экспозиция, температура — температура, хрома — насыщенность, тон —
// тон HSL двух диапазонов вокруг тона плитки. Значение ищется бинарным поиском через весь конвейер (поправка
// фото, образ, LUT образа) на прореженном окне метрик; цель — само ожидание, у тона сетки — край сектора
// с запасом внутрь. Лимит отсчитывается от текущего значения ползунка. Если и лучшее в лимите дальше допуска —
// «заменить»: признак производный, в проект не пишется. «Применить» — applyFix одной правкой slot.adjust.
import { bakePipeline, type PipelineParams } from '../color/bake';
import { HSL_HUE_SHIFT, hueBandPair } from '../color/hsl';
import { hueDistance } from '../color/math';
import { linearSrgbToOklab } from '../color/oklab';
import { applyBaked } from '../color/pipeline';
import { decodeSrgb } from '../color/transfer';
import { toleranceRatio, weightedHueRatio, type DeviationReason } from '../metrics/deviation';
import { meanChroma, meanHue, temperature } from '../metrics/features';
import { metricsWindowSize } from '../metrics/tile';
import { createAdjust } from '../project/defaults';
import type { Adjust, HueBand, Ratio } from '../project/types';
import { EXPOSURE_MAX, SLIDER_MAX } from '../project/validate';
import type { ExpectationSource, TileExpectation } from './outliers';

/** Ползунок поправки фото: экспозиция, температура, насыщенность, тон HSL. */
export type FixSlider = 'exposure' | 'temp' | 'saturation' | 'hslHue';

/** Какой ползунок чинит причину (spec: экспозиция, температура, насыщенность, тон в HSL). */
export const FIX_SLIDERS: Readonly<Record<DeviationReason, FixSlider>> = {
  L: 'exposure',
  temperature: 'temp',
  chroma: 'saturation',
  hue: 'hslHue',
};

/**
 * Лимит поправки — от текущего значения ползунка: ±1 EV и ±20 температуры — из спеки, ±30 насыщенности — свой.
 * Тон HSL — весь ползунок (±30°): его значение задаётся двум диапазонам заново, а не прибавляется.
 */
export const FIX_LIMITS = { exposure: 1, temp: 20, saturation: 30 } as const;

/** Шаг значения поправки: экспозиция — сотые EV, остальные — целые деления, как у ползунков. */
export const FIX_STEP: Readonly<Record<FixSlider, number>> = { exposure: 0.01, temp: 1, saturation: 1, hslHue: 1 };

/** Запас поправки тона внутрь сектора шаблона, градусы: после пересчёта гармонии плитка остаётся внутри. */
export const HUE_FIX_MARGIN = 3;

/** Окно поиска — каждая вторая точка окна метрик по обеим осям: вчетверо быстрее, средние почти те же. */
export const SEARCH_STRIDE = 2;

export const FIX_LABELS: Readonly<Record<FixSlider, string>> = {
  exposure: 'Экспозиция',
  temp: 'Температура',
  saturation: 'Насыщенность',
  hslHue: 'Тон',
};

const BAND_LABELS: Readonly<Record<HueBand, string>> = {
  red: 'красный',
  orange: 'оранжевый',
  yellow: 'жёлтый',
  green: 'зелёный',
  aqua: 'голубой',
  blue: 'синий',
  purple: 'фиолетовый',
  magenta: 'пурпурный',
};

/** Что чинить: худшая причина выброса (TileExpectation.reasons[0]) и откуда ожидание. */
export interface FixTarget {
  reason: DeviationReason;
  /** Величина плитки по окну метрик, как в анализе. */
  value: number;
  /** Ожидание: цель позиции или сетка; у тона сетки — ближайший край сектора. */
  expected: number;
  tolerance: number;
  source: ExpectationSource;
}

export interface TileFix {
  reason: DeviationReason;
  slider: FixSlider;
  /** Тон: два диапазона HSL вокруг тона плитки — оба получают value. */
  bands?: [HueBand, HueBand];
  /** Значение ползунка сейчас; у тона — сдвиг на тоне плитки в делениях (смесь двух диапазонов). */
  from: number;
  /** Новое значение ползунка; у «заменить» — лучшее в пределах лимита. */
  value: number;
  /** Пределы поиска: лимит от текущего значения, срезанный пределами ползунка. */
  range: [number, number];
  /** Куда ведёт поправка: ожидание, у тона сетки — край сектора с запасом внутрь. */
  target: number;
  /** Величина при новом значении, по окну поиска. */
  reached: number;
  /** Отклонение после поправки в долях допуска — как часть выброса. */
  ratio: number;
  /** Цель внутри лимита: значение ведёт ровно к ней. false — лучшее в лимите. */
  exact: boolean;
  /** «Заменить»: и лучшее в лимите дальше допуска. «Применить» нет. */
  replace: boolean;
}

/** Средние по окну после конвейера — всё, из чего считаются величины причин. */
export interface WindowMeans {
  meanL: number;
  meanA: number;
  meanB: number;
  /** Средняя хрома пикселей. */
  meanC: number;
}

/**
 * Окно поиска из окна метрик (windowRgb в tile.ts, RGB подряд, metricsWindowSize точек): каждая вторая
 * точка по обеим осям, начиная с первой.
 */
export function searchWindow(rgb: Float32Array, ratio: Ratio): Float32Array {
  const [width, height] = metricsWindowSize(ratio);
  if (rgb.length !== width * height * 3) throw new Error(`Окно ${width} × ${height}, а точек ${rgb.length / 3}`);
  const w = Math.ceil(width / SEARCH_STRIDE);
  const h = Math.ceil(height / SEARCH_STRIDE);
  const out = new Float32Array(w * h * 3);
  let o = 0;
  for (let y = 0; y < height; y += SEARCH_STRIDE) {
    for (let x = 0; x < width; x += SEARCH_STRIDE) {
      const i = (y * width + x) * 3;
      out[o++] = rgb[i] as number;
      out[o++] = rgb[i + 1] as number;
      out[o++] = rgb[i + 2] as number;
    }
  }
  return out;
}

/** Средние OKLab точек окна (RGB 0..1 подряд) после конвейера. */
export function windowMeans(rgb: Float32Array, params: PipelineParams): WindowMeans {
  const baked = bakePipeline(params);
  const n = Math.floor(rgb.length / 3);
  let L = 0;
  let a = 0;
  let b = 0;
  let C = 0;
  for (let i = 0; i < n; i++) {
    const c = applyBaked([rgb[i * 3] as number, rgb[i * 3 + 1] as number, rgb[i * 3 + 2] as number], baked);
    const lab = linearSrgbToOklab(decodeSrgb(c));
    L += lab[0];
    a += lab[1];
    b += lab[2];
    C += Math.hypot(lab[1], lab[2]);
  }
  if (n === 0) return { meanL: 0, meanA: 0, meanB: 0, meanC: 0 };
  return { meanL: L / n, meanA: a / n, meanB: b / n, meanC: C / n };
}

/** Величина причины по средним — так же, как её считает анализ (outliers.ts). */
export function reasonValue(reason: DeviationReason, m: WindowMeans): number {
  switch (reason) {
    case 'L':
      return m.meanL;
    case 'temperature':
      return temperature(m.meanA, m.meanB);
    case 'chroma':
      return m.meanC;
    case 'hue':
      return meanHue(m.meanA, m.meanB);
  }
}

/** Кратчайшая разность тонов со знаком, −180…180. */
function signedHue(delta: number): number {
  const d = (((delta % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Значение с шагом ползунка: 0.01 → сотые без хвостов плавающей точки. */
function quantize(value: number, step: number): number {
  return Math.round(value / step) / Math.round(1 / step);
}

/**
 * Бинарный поиск значения ползунка в [lo, hi], при котором величина f равна target; f монотонна по ползунку.
 * guess — первая точка деления, если она внутри (у насыщенности — отношение хром). Результат — значение
 * с шагом step и exact: цель внутри [f(lo), f(hi)]. Иначе — ближайший к цели край.
 */
export function searchSlider(
  f: (value: number) => number,
  lo: number,
  hi: number,
  target: number,
  step: number,
  guess?: number,
): { value: number; exact: boolean } {
  const fLo = f(lo);
  const fHi = f(hi);
  const sign = fHi >= fLo ? 1 : -1;
  if (sign * (fLo - target) >= 0) return { value: lo, exact: fLo === target };
  if (sign * (fHi - target) <= 0) return { value: hi, exact: fHi === target };
  let a = lo;
  let b = hi;
  let probe = guess !== undefined && guess > a && guess < b ? guess : (a + b) / 2;
  while (b - a > step / 2) {
    if (sign * (f(probe) - target) < 0) a = probe;
    else b = probe;
    probe = (a + b) / 2;
  }
  return { value: Math.min(hi, Math.max(lo, quantize(probe, step))), exact: true };
}

/** Поправка фото с новым значением ползунка; исходная не меняется. */
export function withFix(adjust: Adjust, fix: Pick<TileFix, 'slider' | 'value' | 'bands'>): Adjust {
  const next: Adjust = { ...adjust, hsl: { ...adjust.hsl } };
  applyFix(next, fix);
  return next;
}

/** «Применить»: значение ползунка в поправку фото (черновик Immer или копия). Тон — обоим диапазонам. */
export function applyFix(adjust: Adjust, fix: Pick<TileFix, 'slider' | 'value' | 'bands'>): void {
  switch (fix.slider) {
    case 'exposure':
      adjust.exposure = fix.value;
      return;
    case 'temp':
      adjust.temp = fix.value;
      return;
    case 'saturation':
      adjust.saturation = fix.value;
      return;
    case 'hslHue':
      for (const band of fix.bands ?? []) adjust.hsl[band] = { ...adjust.hsl[band], hue: fix.value };
  }
}

/**
 * «Применить все» (docs/decisions/0025-fit.md): готовые поправки выбросов с целью позиции, в порядке выбросов.
 * Ожидание цели не зависит от соседей, поэтому поправки не мешают друг другу — довод ADR 0021 против
 * «Применить все» здесь не работает. Опубликованные, «заменить» и ещё не посчитанные пропускаются.
 */
export function targetFixes(
  outliers: readonly Pick<TileExpectation, 'slotId' | 'source' | 'published'>[],
  fixes: Readonly<Record<string, TileFix | undefined>>,
): { slotId: string; fix: TileFix }[] {
  return outliers.flatMap((outlier) => {
    const fix = fixes[outlier.slotId];
    if (outlier.source !== 'target' || outlier.published || !fix || fix.replace) return [];
    return [{ slotId: outlier.slotId, fix }];
  });
}

/** Шаги 1–6 поправки фото: так тон плитки входит в HSL (шаг 7). */
function beforeHsl(adjust: Adjust): Adjust {
  const neutral = createAdjust();
  return { ...adjust, hsl: neutral.hsl, grading: neutral.grading, vibrance: 0, saturation: 0 };
}

/**
 * Поправка для худшей причины выброса. rgb — окно поиска (searchWindow), params — конвейер плитки: поправка
 * фото, образ и LUT образа. Ищется значение одного ползунка поправки фото.
 */
export function findFix(rgb: Float32Array, params: PipelineParams, target: FixTarget): TileFix {
  const { reason } = target;
  const slider = FIX_SLIDERS[reason];
  const photo = params.photo;
  const measure = (adjust: Adjust): WindowMeans => windowMeans(rgb, { ...params, photo: adjust });
  const current = measure(photo);
  const now = reasonValue(reason, current);

  let bands: [HueBand, HueBand] | undefined;
  let from: number;
  let range: [number, number];
  let goal = target.expected;
  let guess: number | undefined;
  // Величина как функция ползунка; у тона — сдвиг от нынешнего тона со знаком, чтобы не мешал переход 360° → 0°.
  let f: (means: WindowMeans) => number = (m) => reasonValue(reason, m);
  let goalF = goal;
  switch (slider) {
    case 'exposure':
      from = photo.exposure;
      range = [Math.max(-EXPOSURE_MAX, from - FIX_LIMITS.exposure), Math.min(EXPOSURE_MAX, from + FIX_LIMITS.exposure)];
      // L OKLab — кубический корень яркости: у серого без тональной кривой ×2^(3·log2(L₁/L₀)).
      if (now > 0 && goal > 0) guess = from + 3 * Math.log2(goal / now);
      break;
    case 'temp':
      from = photo.temp;
      range = [Math.max(-SLIDER_MAX, from - FIX_LIMITS.temp), Math.min(SLIDER_MAX, from + FIX_LIMITS.temp)];
      break;
    case 'saturation':
      from = photo.saturation;
      range = [Math.max(-SLIDER_MAX, from - FIX_LIMITS.saturation), Math.min(SLIDER_MAX, from + FIX_LIMITS.saturation)];
      // Насыщенность умножает хрому на 1 + s/100: отношение хром — первая точка, срез в охват уточняет поиск.
      if (now > 1e-6) guess = (1 + from / 100) * (goal / now) * 100 - 100;
      break;
    case 'hslHue': {
      // Цель — ожидание; у сетки это край сектора, поправка ведёт за него внутрь на HUE_FIX_MARGIN.
      if (target.source === 'grid') {
        const inward = signedHue(target.expected - target.value);
        if (inward !== 0) goal = target.expected + Math.sign(inward) * HUE_FIX_MARGIN;
      }
      // Диапазоны — по тону на входе HSL (после шагов 1–6 поправки фото), а не по тону после образа.
      const input = windowMeans(rgb, { photo: beforeHsl(photo) });
      const pair = hueBandPair(meanHue(input.meanA, input.meanB));
      bands = pair.bands;
      from = (1 - pair.weight) * photo.hsl[bands[0]].hue + pair.weight * photo.hsl[bands[1]].hue;
      range = [-SLIDER_MAX, SLIDER_MAX];
      f = (m) => signedHue(meanHue(m.meanA, m.meanB) - now);
      goalF = signedHue(goal - now);
      guess = from + (goalF / HSL_HUE_SHIFT) * 100;
      goal = ((goal % 360) + 360) % 360;
      break;
    }
  }

  const memo = new Map<number, WindowMeans>();
  const at = (value: number): WindowMeans => {
    let m = memo.get(value);
    if (!m) {
      m = value === from && slider !== 'hslHue' ? current : measure(withFix(photo, { slider, value, ...(bands ? { bands } : {}) }));
      memo.set(value, m);
    }
    return m;
  };
  const { value, exact } = searchSlider((v) => f(at(v)), range[0], range[1], goalF, FIX_STEP[slider], guess);
  const reached = at(value);
  const reachedValue = reasonValue(reason, reached);
  const ratio = ratioAfter(target, reachedValue, reached);
  return {
    reason,
    slider,
    ...(bands ? { bands } : {}),
    from,
    value,
    range,
    target: goal,
    reached: reachedValue,
    ratio,
    exact,
    replace: ratio > 1,
  };
}

/** Отклонение после поправки в долях допуска — той же формы, что часть выброса (outliers.ts, deviation.ts). */
function ratioAfter(target: FixTarget, reached: number, m: WindowMeans): number {
  if (target.reason !== 'hue') return toleranceRatio(reached - target.expected, target.tolerance);
  if (target.source === 'target') return weightedHueRatio(hueDistance(reached, target.expected), target.tolerance, m.meanC);
  // Сетка: градусы за краем сектора с той стороны, где была плитка; перешла за край внутрь — 0.
  const outward = Math.sign(signedHue(target.value - target.expected));
  const beyond = Math.max(0, outward * signedHue(reached - target.expected));
  return weightedHueRatio(beyond, target.tolerance, meanChroma(m.meanA, m.meanB));
}

/** «+0.35», «−12»: знак всегда, минус типографский. */
function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${value < 0 ? '−' : '+'}${text}`;
}

/** Изменение ползунка подписью: «+0.35 EV», «−12». */
export function formatFixDelta(fix: Pick<TileFix, 'slider' | 'from' | 'value'>): string {
  const delta = fix.value - fix.from;
  return fix.slider === 'exposure' ? `${signed(delta, 2)} EV` : signed(delta, 0);
}

/** «Экспозиция +0.35 EV», «Тон −40 · голубой и синий». */
export function formatFix(fix: Pick<TileFix, 'slider' | 'from' | 'value' | 'bands'>): string {
  const text = `${FIX_LABELS[fix.slider]} ${formatFixDelta(fix)}`;
  return fix.bands ? `${text} · ${BAND_LABELS[fix.bands[0]]} и ${BAND_LABELS[fix.bands[1]]}` : text;
}

/** Значение ползунка: «0.35 EV», «−12». */
export function formatSliderValue(slider: FixSlider, value: number): string {
  const text = slider === 'exposure' ? `${value.toFixed(2)} EV` : value.toFixed(0);
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}
