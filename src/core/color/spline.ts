// Монотонный кубический сплайн Фрича — Карлсона (1980): между точками нет выбросов,
// монотонные данные дают монотонную кривую. Им интерполируются кривые (шаг 6).
import type { Pt } from '../project/types';

/**
 * Кривая через точки. Точки сортируются по x, из точек с одинаковым x остаётся первая.
 * За крайними точками значение не меняется. Без точек — тождество, одна точка — константа.
 */
export function monotoneSpline(points: readonly Pt[]): (x: number) => number {
  const sorted = [...points].sort((p, q) => p[0] - q[0]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of sorted) {
    if (xs.length > 0 && x <= (xs[xs.length - 1] as number)) continue;
    xs.push(x);
    ys.push(y);
  }

  const n = xs.length;
  if (n === 0) return (x) => x;
  if (n === 1) {
    const y = ys[0] as number;
    return () => y;
  }

  const at = (arr: number[], i: number) => arr[i] as number;
  const secants = Array.from({ length: n - 1 }, (_, k) => (at(ys, k + 1) - at(ys, k)) / (at(xs, k + 1) - at(xs, k)));
  const tangents = Array.from({ length: n }, (_, k) => {
    if (k === 0) return at(secants, 0);
    if (k === n - 1) return at(secants, n - 2);
    const left = at(secants, k - 1);
    const right = at(secants, k);
    // На экстремуме данных и рядом с плоским участком касательная горизонтальна.
    return left * right <= 0 ? 0 : (left + right) / 2;
  });
  for (let k = 0; k < n - 1; k++) {
    const d = at(secants, k);
    if (d === 0) {
      tangents[k] = 0;
      tangents[k + 1] = 0;
      continue;
    }
    const alpha = at(tangents, k) / d;
    const beta = at(tangents, k + 1) / d;
    const norm = alpha * alpha + beta * beta;
    if (norm > 9) {
      const tau = 3 / Math.sqrt(norm);
      tangents[k] = tau * alpha * d;
      tangents[k + 1] = tau * beta * d;
    }
  }

  const x0 = at(xs, 0);
  const xn = at(xs, n - 1);
  return (x) => {
    if (x <= x0) return at(ys, 0);
    if (x >= xn) return at(ys, n - 1);
    let k = 0;
    while (k < n - 2 && x >= at(xs, k + 1)) k++;
    const h = at(xs, k + 1) - at(xs, k);
    const t = (x - at(xs, k)) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * at(ys, k) +
      (t3 - 2 * t2 + t) * h * at(tangents, k) +
      (-2 * t3 + 3 * t2) * at(ys, k + 1) +
      (t3 - t2) * h * at(tangents, k + 1)
    );
  };
}

/** n значений кривой в равномерных точках от x = 0 до x = 1. */
export function sampleCurve(points: readonly Pt[], n: number): Float64Array {
  const f = monotoneSpline(points);
  return Float64Array.from({ length: n }, (_, i) => f(i / (n - 1)));
}

/** Тождественная ли кривая: две точки (0, 0) и (1, 1). */
export function isIdentityCurve(points: readonly Pt[]): boolean {
  if (points.length !== 2) return false;
  const [a, b] = [...points].sort((p, q) => p[0] - q[0]) as [Pt, Pt];
  return a[0] === 0 && a[1] === 0 && b[0] === 1 && b[1] === 1;
}
