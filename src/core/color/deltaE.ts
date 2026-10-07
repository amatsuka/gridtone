// Цветовое различие CIEDE2000 и перевод sRGB → CIELAB (D65).
// Реализация по G. Sharma, W. Wu, E. N. Dalal (2005), сверена с их тестовыми данными.
import { D65_XYZ, mulMat3, SRGB_TO_XYZ, type Lab, type Rgb } from './srgb';
import { decodeSrgb } from './transfer';

const DEG = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp /= 2;
    else hbarp = h1p + h2p < 360 ? (hbarp + 360) / 2 : (hbarp - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50 = (Lbarp - 50) * (Lbarp - 50);
  const SL = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  const l = dLp / SL;
  const c = dCp / SC;
  const h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

function hueAngle(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/** Гамма-кодированный sRGB 0..1 → CIELAB с белой точкой D65. */
export function srgbToCielab(rgb: Rgb): Lab {
  const [x, y, z] = mulMat3(SRGB_TO_XYZ, decodeSrgb(rgb));
  const fx = labF(x / D65_XYZ[0]);
  const fy = labF(y / D65_XYZ[1]);
  const fz = labF(z / D65_XYZ[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

function labF(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}
