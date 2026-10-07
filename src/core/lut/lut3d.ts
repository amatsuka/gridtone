// Трёхмерная таблица цвета (3D LUT): решётка size³ узлов, в каждом — выходной цвет.
// Раскладка как в `.cube`: R меняется быстрее всех, затем G, затем B.
// Интерполяция — тетраэдрическая (так LUT применяет Photoshop) и трилинейная (по умолчанию в Resolve).
// Шейдер шага 9 (этап 3б) повторяет tetrahedral тем же выбором тетраэдра и теми же весами.
import type { Rgb } from '../color/srgb';

/** Размеры решётки, которые принимает импорт `.cube` (docs/decisions/0014-lut-export.md). */
export const LUT_SIZE_MIN = 2;
export const LUT_SIZE_MAX = 65;

export interface LutDomain {
  min: Rgb;
  max: Rgb;
}

export interface Lut3D {
  /** Узлов по каждой оси. */
  size: number;
  /** Вход, который приходится на первый и последний узел; вне домена вход срезается. */
  domainMin: Rgb;
  domainMax: Rgb;
  /** size³ узлов по 3 канала, R быстрее всех. Float64: узлы запечённого LUT бит в бит равны конвейеру. */
  data: Float64Array;
  title?: string;
}

export type LutInterpolation = 'tetrahedral' | 'trilinear';

const UNIT_DOMAIN: LutDomain = { min: [0, 0, 0], max: [1, 1, 1] };

/** Индекс первого канала узла (r, g, b) в Lut3D.data. */
export function lutIndex(size: number, r: number, g: number, b: number): number {
  return ((b * size + g) * size + r) * 3;
}

/** Решётка, где в узле — f от его входа. Вход узла i по оси: min + (max − min)·i/(size − 1). */
export function createLut(size: number, f: (rgb: Rgb) => Rgb, domain: LutDomain = UNIT_DOMAIN): Lut3D {
  if (!Number.isInteger(size) || size < 2) throw new Error(`Размер LUT ${size}: нужно целое не меньше 2`);
  const { min, max } = domain;
  const n = size - 1;
  const axis = (c: 0 | 1 | 2, i: number) => (i === 0 ? min[c] : i === n ? max[c] : min[c] + ((max[c] - min[c]) * i) / n);
  const data = new Float64Array(size * size * size * 3);
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = f([axis(0, r), axis(1, g), axis(2, b)]);
        data[p++] = out[0];
        data[p++] = out[1];
        data[p++] = out[2];
      }
    }
  }
  return { size, domainMin: [...min], domainMax: [...max], data };
}

export function identityLut(size: number): Lut3D {
  return createLut(size, (rgb) => rgb);
}

/** Цвет rgb через LUT. Выход не срезается: это делает тот, кто применяет LUT. */
export function sampleLut(lut: Lut3D, rgb: Rgb, interpolation: LutInterpolation = 'tetrahedral'): Rgb {
  const n = lut.size - 1;
  const pr = position(rgb[0], lut.domainMin[0], lut.domainMax[0], n);
  const pg = position(rgb[1], lut.domainMin[1], lut.domainMax[1], n);
  const pb = position(rgb[2], lut.domainMin[2], lut.domainMax[2], n);
  // Последняя ячейка — [n − 1, n]: вход на верхней границе даёт её дальний узел с весом 1.
  const ir = Math.min(Math.floor(pr), n - 1);
  const ig = Math.min(Math.floor(pg), n - 1);
  const ib = Math.min(Math.floor(pb), n - 1);
  const fr = pr - ir;
  const fg = pg - ig;
  const fb = pb - ib;
  return interpolation === 'tetrahedral'
    ? tetrahedral(lut, ir, ig, ib, fr, fg, fb)
    : trilinear(lut, ir, ig, ib, fr, fg, fb);
}

/** Положение входа в решётке, 0..n. */
function position(v: number, min: number, max: number, n: number): number {
  const t = (v - min) / (max - min);
  return (t <= 0 ? 0 : t >= 1 ? 1 : t) * n;
}

/**
 * Ячейка делится диагональю (0,0,0)–(1,1,1) на шесть тетраэдров. Тетраэдр выбирается порядком
 * дробных частей: путь из угла 000 в 111 идёт сначала по оси с наибольшей дробью. Веса — разности
 * упорядоченных дробей. На гранях тетраэдров соседние формулы совпадают, поэтому выбор при равенстве
 * не важен, а серый вход (fr = fg = fb) берёт только узлы диагонали.
 */
function tetrahedral(lut: Lut3D, ir: number, ig: number, ib: number, fr: number, fg: number, fb: number): Rgb {
  const { size, data } = lut;
  const c000 = lutIndex(size, ir, ig, ib);
  const c111 = lutIndex(size, ir + 1, ig + 1, ib + 1);
  const dr = 3;
  const dg = size * 3;
  const db = size * size * 3;
  let v1: number;
  let v2: number;
  let w0: number;
  let w1: number;
  let w2: number;
  let w3: number;
  if (fr >= fg) {
    if (fg >= fb) {
      // r ≥ g ≥ b: 000 → 100 → 110 → 111
      v1 = c000 + dr;
      v2 = c000 + dr + dg;
      w0 = 1 - fr;
      w1 = fr - fg;
      w2 = fg - fb;
      w3 = fb;
    } else if (fr >= fb) {
      // r ≥ b > g: 000 → 100 → 101 → 111
      v1 = c000 + dr;
      v2 = c000 + dr + db;
      w0 = 1 - fr;
      w1 = fr - fb;
      w2 = fb - fg;
      w3 = fg;
    } else {
      // b > r ≥ g: 000 → 001 → 101 → 111
      v1 = c000 + db;
      v2 = c000 + dr + db;
      w0 = 1 - fb;
      w1 = fb - fr;
      w2 = fr - fg;
      w3 = fg;
    }
  } else if (fb >= fg) {
    // b ≥ g > r: 000 → 001 → 011 → 111
    v1 = c000 + db;
    v2 = c000 + dg + db;
    w0 = 1 - fb;
    w1 = fb - fg;
    w2 = fg - fr;
    w3 = fr;
  } else if (fb >= fr) {
    // g > b ≥ r: 000 → 010 → 011 → 111
    v1 = c000 + dg;
    v2 = c000 + dg + db;
    w0 = 1 - fg;
    w1 = fg - fb;
    w2 = fb - fr;
    w3 = fr;
  } else {
    // g > r > b: 000 → 010 → 110 → 111
    v1 = c000 + dg;
    v2 = c000 + dr + dg;
    w0 = 1 - fg;
    w1 = fg - fr;
    w2 = fr - fb;
    w3 = fb;
  }
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      w0 * (data[c000 + c] as number) +
      w1 * (data[v1 + c] as number) +
      w2 * (data[v2 + c] as number) +
      w3 * (data[c111 + c] as number);
  }
  return out;
}

/** Восемь узлов ячейки, линейно по R, затем по G, затем по B. */
function trilinear(lut: Lut3D, ir: number, ig: number, ib: number, fr: number, fg: number, fb: number): Rgb {
  const { size, data } = lut;
  const c000 = lutIndex(size, ir, ig, ib);
  const dr = 3;
  const dg = size * 3;
  const db = size * size * 3;
  // a·(1 − t) + b·t, а не a + (b − a)·t: при t = 1 получается ровно b, и узлы возвращаются бит в бит.
  const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (offset: number) => data[c000 + offset + c] as number;
    const x00 = mix(at(0), at(dr), fr);
    const x10 = mix(at(dg), at(dr + dg), fr);
    const x01 = mix(at(db), at(dr + db), fr);
    const x11 = mix(at(dg + db), at(dr + dg + db), fr);
    out[c] = mix(mix(x00, x10, fg), mix(x01, x11, fg), fb);
  }
  return out;
}
