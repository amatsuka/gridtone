// OKLab и OKLCH — Björn Ottosson, «A perceptual color space for image processing» (2020).
// Матрицы взяты из статьи без изменений: от них зависит совпадение с её опорными значениями.
import type { Lab, Lch, Mat3, Rgb } from './srgb';
import { mulMat3 } from './srgb';

export const LINEAR_SRGB_TO_LMS: Mat3 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];

export const LMS_TO_LINEAR_SRGB: Mat3 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

const XYZ_TO_LMS: Mat3 = [
  [0.8189330101, 0.3618667424, -0.1288597137],
  [0.0329845436, 0.9293118715, 0.0361456387],
  [0.0482003018, 0.2643662691, 0.633851707],
];

export const LMS_TO_LAB: Mat3 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

export const LAB_TO_LMS: Mat3 = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];

function lmsToLab(lms: Rgb): Lab {
  return mulMat3(LMS_TO_LAB, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

export function linearSrgbToOklab(rgb: Rgb): Lab {
  return lmsToLab(mulMat3(LINEAR_SRGB_TO_LMS, rgb));
}

export function oklabToLinearSrgb(lab: Lab): Rgb {
  const [l, m, s] = mulMat3(LAB_TO_LMS, lab);
  return mulMat3(LMS_TO_LINEAR_SRGB, [l * l * l, m * m * m, s * s * s]);
}

/** Для сверки с таблицей Оттоссона: в конвейере XYZ не нужен. */
export function xyzToOklab(xyz: Rgb): Lab {
  return lmsToLab(mulMat3(XYZ_TO_LMS, xyz));
}

/** Тон в градусах 0..360. */
export function oklabToOklch([L, a, b]: Lab): Lch {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

export function oklchToOklab([L, C, h]: Lch): Lab {
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}
