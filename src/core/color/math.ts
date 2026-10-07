// Мелкие функции, которые должны считаться одинаково в core и в шейдере.

/** Как smoothstep в GLSL. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Как mix в GLSL: a·(1−t) + b·t. */
export function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

/** Расстояние между тонами в градусах, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Линейная интерполяция по таблице из n узлов от x = 0 до x = 1, канал c из stride. */
export function sampleTable(table: Float32Array, n: number, stride: number, c: number, x: number): number {
  const pos = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  const t = pos - i;
  return mix(table[i * stride + c] as number, table[(i + 1) * stride + c] as number, t);
}

/** То же по кругу: n узлов на 0..360°, узел k — тон k·360/n. */
export function sampleHueTable(table: Float32Array, n: number, stride: number, c: number, hue: number): number {
  const pos = (hue / 360) * n;
  const base = Math.floor(pos);
  const t = pos - base;
  const i = ((base % n) + n) % n;
  const j = (i + 1) % n;
  return mix(table[i * stride + c] as number, table[j * stride + c] as number, t);
}
