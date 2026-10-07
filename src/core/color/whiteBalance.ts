// Баланс белого, шаг 2 конвейера. Модель — docs/decisions/0007-white-balance.md.
import { luminance, mulMat3, XYZ_TO_SRGB, type Rgb } from './srgb';

/** Номинальная цветовая температура D65 в майредах. */
export const MIRED_D65 = 1e6 / 6504;
/** Одно деление температуры — 1 майред. */
export const MIRED_PER_UNIT = 1;
/** Одно деление оттенка — 0.0002 Duv; плюс уводит под локус, к пурпурному. */
export const DUV_PER_UNIT = -0.0002;

type Uv = [number, number];

/** Локус Планка в (u, v) МКО 1960, рациональная аппроксимация Крыстека (1985). */
export function planckianUv(kelvin: number): Uv {
  const t = kelvin;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  return [u, v];
}

/**
 * Белая точка: точка локуса при данных майредах, сдвинутая по нормали на duv.
 * Положительный duv — над локусом, к зелёному.
 */
export function whitePointUv(mired: number, duv: number): Uv {
  const [u, v] = planckianUv(1e6 / mired);
  if (duv === 0) return [u, v];
  // Касательная по направлению роста майред (к тёплому); нормаль — её поворот на 90° против часовой.
  const h = 1e-3;
  const [u0, v0] = planckianUv(1e6 / (mired - h));
  const [u1, v1] = planckianUv(1e6 / (mired + h));
  const length = Math.hypot(u1 - u0, v1 - v0);
  const tu = (u1 - u0) / length;
  const tv = (v1 - v0) / length;
  return [u - duv * tv, v + duv * tu];
}

export function uvToXy([u, v]: Uv): [number, number] {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/** Линейный sRGB белой точки с Y = 1. */
function whiteRgb(mired: number, duv: number): Rgb {
  const [x, y] = uvToXy(whitePointUv(mired, duv));
  return mulMat3(XYZ_TO_SRGB, [x / y, 1, (1 - x - y) / y]);
}

/**
 * Коэффициенты каналов линейного sRGB: нейтральный серый становится цветом белой точки,
 * сдвинутой на temp майред от D65 и на tint по нормали. Яркость серого не меняется.
 */
export function whiteBalanceGains(temp: number, tint: number): Rgb {
  if (temp === 0 && tint === 0) return [1, 1, 1];
  const target = whiteRgb(MIRED_D65 + MIRED_PER_UNIT * temp, DUV_PER_UNIT * tint);
  const reference = whiteRgb(MIRED_D65, 0);
  const gains: Rgb = [target[0] / reference[0], target[1] / reference[1], target[2] / reference[2]];
  // Делим на яркость (1, 1, 1), а не на 1: строка Y матрицы sRGB с 7 знаками в сумме даёт 1.0000001.
  const y = luminance(gains) / luminance([1, 1, 1]);
  return [gains[0] / y, gains[1] / y, gains[2] / y];
}
