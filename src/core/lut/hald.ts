// HaldCLUT — LUT в виде картинки (darktable, RawTherapee, G'MIC). Уровень L: куб L² узлов по оси
// в квадрате L³ × L³ точек. Узлы идут подряд по строкам, R быстрее всех — как строки `.cube`.
// Тождественный Hald — это сама решётка: в точке узла лежит его цвет.
import type { Lut3D } from './lut3d';

/** Уровень 8: куб 64³ в PNG 512 × 512 (docs/spec.md, «Форматы»). */
export const HALD_LEVEL = 8;

/** Узлов по оси и сторона квадрата. */
export function haldGeometry(level: number): { size: number; width: number } {
  return { size: level * level, width: level * level * level };
}

/** Точка (x, y) узла (r, g, b) в картинке уровня level. */
export function haldPosition(level: number, r: number, g: number, b: number): [number, number] {
  const { size, width } = haldGeometry(level);
  const i = r + size * (g + size * b);
  return [i % width, Math.floor(i / width)];
}

export interface HaldImage {
  width: number;
  height: number;
  /** RGB 16 бит, строки сверху вниз. */
  data: Uint16Array;
}

/** Картинка Hald из решётки L² узлов на домене 0..1. Значения срезаются в 0..1 и округляются до 16 бит. */
export function lutToHald(lut: Lut3D): HaldImage {
  const level = Math.round(Math.sqrt(lut.size));
  if (level * level !== lut.size) throw new Error(`HaldCLUT: размер решётки ${lut.size} — не квадрат уровня`);
  if (lut.domainMin.some((v) => v !== 0) || lut.domainMax.some((v) => v !== 1)) {
    throw new Error('HaldCLUT: домен решётки должен быть 0..1');
  }
  const { width } = haldGeometry(level);
  const data = new Uint16Array(width * width * 3);
  // Порядок узлов в картинке совпадает с порядком в Lut3D.data.
  for (let i = 0; i < data.length; i++) {
    const v = lut.data[i] as number;
    data[i] = Math.round((v <= 0 ? 0 : v >= 1 ? 1 : v) * 65535);
  }
  return { width, height: width, data };
}

/** Решётка из картинки Hald: RGB по 3 значения на точку, maxValue — 65535 для 16 бит, 255 для 8. */
export function haldToLut(image: { width: number; height: number; data: ArrayLike<number> }, maxValue = 65535): Lut3D {
  const { width, height, data } = image;
  const level = Math.round(Math.cbrt(width));
  if (width !== height || level ** 3 !== width || data.length !== width * height * 3) {
    throw new Error(`Картинка ${width} × ${height} — не HaldCLUT: нужен квадрат со стороной L³`);
  }
  // Порядок точек — порядок узлов, как в lutToHald.
  return {
    size: haldGeometry(level).size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data: Float64Array.from(data, (v) => v / maxValue),
  };
}
