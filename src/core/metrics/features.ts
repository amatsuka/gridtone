// Признаки плитки (docs/spec.md, «Метрики плитки»; docs/decisions/0018-features-grid-metrics.md): всё из `Features`
// по пикселям окна в OKLab. Функция не знает ни о проекте, ни о воркере: её же возьмут индекс библиотеки
// и разбор референса (этапы 6–7). Окно метрик — 192 точки по ширине (tile.ts); плотность от него зависит,
// поэтому признаки сравниваются только между окнами одного размера.
import { linearSrgbToOklab } from '../color/oklab';
import { whiteBalanceGains } from '../color/whiteBalance';
import type { Features } from '../project/types';
import { labStats, palette } from './palette';

/** Корзин гистограммы L равной ширины на 0..1. */
export const L_HIST_BINS = 8;
/** Корзин гистограммы тонов по 30°, корзина k — тона [30k, 30k + 30). */
export const HUE_HIST_BINS = 12;
/** Пиксель с хромой ниже этой — нейтральный (spec). */
export const NEUTRAL_CHROMA = 0.03;
/** Высокий ключ — доля пикселей с L выше этой (spec). */
export const HIGH_KEY_L = 0.8;
/** Низкий ключ — доля пикселей с L ниже этой (spec). */
export const LOW_KEY_L = 0.3;

/** Делений в пробном сдвиге: направления осей берутся по разности ±1 деления, у нуля. */
const PROBE = 1;
/** Серый для пробы, линейный. Направления от уровня серого не зависят: OKLab масштабирует (a, b) кубическим корнем. */
const PROBE_GRAY = 0.18;

/** Единичный вектор в плоскости (a, b), по которому шаг 2 конвейера (`whiteBalanceGains`) сдвигает серый. */
function whiteBalanceAxis(temp: number, tint: number): [number, number] {
  const ab = (sign: number): [number, number] => {
    const [r, g, b] = whiteBalanceGains(sign * temp, sign * tint);
    const lab = linearSrgbToOklab([PROBE_GRAY * r, PROBE_GRAY * g, PROBE_GRAY * b]);
    return [lab[1], lab[2]];
  };
  const [a1, b1] = ab(1);
  const [a0, b0] = ab(-1);
  const length = Math.hypot(a1 - a0, b1 - b0);
  return [(a1 - a0) / length, (b1 - b0) / length];
}

/** Ось температуры: куда ползунок температуры сдвигает серый (около 79° в плоскости (a, b), почти по b). */
export const TEMPERATURE_AXIS: readonly [number, number] = whiteBalanceAxis(PROBE, 0);
/** Ось оттенка: куда сдвигает серый ползунок оттенка (около −31°, к пурпурному). */
export const TINT_AXIS: readonly [number, number] = whiteBalanceAxis(0, PROBE);

/**
 * Температура плитки — «среднее b с поправкой на a» (spec): координата среднего (a, b) вдоль оси температуры
 * в косоугольном базисе «ось температуры, ось оттенка». Оси не перпендикулярны (около 110°), поэтому это
 * проекция вдоль оси оттенка: оттенок температуру не меняет, а поправка температуры двигает плитку ровно
 * по той оси, по которой её меряют. Больше нуля — тёплая, меньше — холодная; единицы — OKLab.
 */
export function temperature(meanA: number, meanB: number): number {
  const [ua, ub] = TEMPERATURE_AXIS;
  const [va, vb] = TINT_AXIS;
  return (meanA * vb - meanB * va) / (ua * vb - ub * va);
}

/** Тон среднего цвета (a, b), градусы 0..360; у серого 0. По нему плитка ложится на колесо и в гармонию. */
export function meanHue(meanA: number, meanB: number): number {
  if (meanA === 0 && meanB === 0) return 0;
  const h = (Math.atan2(meanB, meanA) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** Хрома среднего цвета: плитка из двух противоположных тонов ложится к центру колеса. */
export function meanChroma(meanA: number, meanB: number): number {
  return Math.hypot(meanA, meanB);
}

/**
 * labs — пиксели окна в OKLab подряд (L, a, b), width × height, строки сверху вниз.
 * - перцентили L — линейная интерполяция между порядковыми статистиками (позиция q·(n − 1));
 * - lHist — доли пикселей по корзинам L, в сумме 1; L ≥ 1 попадает в последнюю;
 * - hueHist — сумма хром пикселей корзины, делённая на число пикселей: в сумме meanC;
 * - палитра — k-means плитки (palette.ts);
 * - плотность — средний модуль градиента L по Собелю (ядро / 8 — перепад L на точку окна) во внутренних точках.
 */
export function tileFeatures(labs: Float32Array | Float64Array, width: number, height: number): Features {
  const n = width * height;
  if (labs.length !== n * 3) throw new Error(`Окно ${width} × ${height}, а точек ${labs.length / 3}`);
  const stats = labStats(labs);
  const lHist = new Array<number>(L_HIST_BINS).fill(0);
  const hueHist = new Array<number>(HUE_HIST_BINS).fill(0);
  const sorted = new Float64Array(n);
  let neutral = 0;
  let high = 0;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const L = labs[i * 3] as number;
    const a = labs[i * 3 + 1] as number;
    const b = labs[i * 3 + 2] as number;
    const C = Math.hypot(a, b);
    sorted[i] = L;
    lHist[Math.min(L_HIST_BINS - 1, Math.max(0, Math.floor(L * L_HIST_BINS)))]! += 1;
    if (C > 0) hueHist[Math.floor(meanHue(a, b) / (360 / HUE_HIST_BINS)) % HUE_HIST_BINS]! += C;
    if (C < NEUTRAL_CHROMA) neutral++;
    if (L > HIGH_KEY_L) high++;
    if (L < LOW_KEY_L) low++;
  }
  sorted.sort();
  const share = (count: number) => (n === 0 ? 0 : count / n);

  return {
    meanL: stats.meanL,
    p05L: percentile(sorted, 0.05),
    p50L: percentile(sorted, 0.5),
    p95L: percentile(sorted, 0.95),
    lHist: lHist.map(share),
    meanA: stats.meanA,
    meanB: stats.meanB,
    meanC: stats.meanC,
    hueHist: hueHist.map(share),
    palette: palette(labs),
    neutralShare: share(neutral),
    highKeyShare: share(high),
    lowKeyShare: share(low),
    busyness: sobelEnergy(labs, width, height),
  };
}

/** q-й перцентиль упорядоченного массива, q в 0..1. */
export function percentile(sorted: Float64Array | readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const position = Math.min(1, Math.max(0, q)) * (n - 1);
  const i = Math.floor(position);
  const t = position - i;
  const a = sorted[i] as number;
  return t === 0 ? a : a + ((sorted[i + 1] as number) - a) * t;
}

/** Средний модуль градиента L по Собелю во внутренних точках окна; у окна меньше 3 × 3 — 0. */
function sobelEnergy(labs: Float32Array | Float64Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  const L = (x: number, y: number) => labs[(y * width + x) * 3] as number;
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Сначала разности: у однотонного окна градиент ровно 0.
      const gx = L(x + 1, y - 1) - L(x - 1, y - 1) + 2 * (L(x + 1, y) - L(x - 1, y)) + (L(x + 1, y + 1) - L(x - 1, y + 1));
      const gy = L(x - 1, y + 1) - L(x - 1, y - 1) + 2 * (L(x, y + 1) - L(x, y - 1)) + (L(x + 1, y + 1) - L(x + 1, y - 1));
      sum += Math.hypot(gx, gy) / 8;
    }
  }
  return sum / ((width - 2) * (height - 2));
}
