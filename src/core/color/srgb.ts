// Пространство sRGB (IEC 61966-2-1): основные цвета, белая точка D65, яркость.

export type Rgb = [number, number, number];
/** OKLab или CIELAB: L, a, b. */
export type Lab = [number, number, number];
/** OKLCH: L, хрома, тон в градусах 0..360. */
export type Lch = [number, number, number];
export type Mat3 = readonly [Rgb, Rgb, Rgb];

/** Строка Y матрицы sRGB → XYZ: вклад каналов линейного sRGB в яркость. */
export const LUMINANCE: Rgb = [0.2126729, 0.7151522, 0.072175];

export const SRGB_TO_XYZ: Mat3 = [
  [0.4124564, 0.3575761, 0.1804375],
  LUMINANCE,
  [0.0193339, 0.119192, 0.9503041],
];

export const XYZ_TO_SRGB: Mat3 = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

/** Белая точка D65 в XYZ, Y = 1. */
export const D65_XYZ: Rgb = [0.95047, 1, 1.08883];

export function mulMat3(m: Mat3, v: readonly number[]): Rgb {
  const [x = 0, y = 0, z = 0] = v;
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

/** Яркость Y линейного sRGB. */
export function luminance(rgb: Rgb): number {
  return LUMINANCE[0] * rgb[0] + LUMINANCE[1] * rgb[1] + LUMINANCE[2] * rgb[2];
}
