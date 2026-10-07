// Эталонные изображения для сверки конвейеров: синтетические, строятся на лету, в репозиторий
// бинарники не попадают. Покрывают рампы, круг тонов, телесные тона, почти-серые и весь куб RGB.
import { oklabToLinearSrgb, oklchToOklab } from '../../src/core/color/oklab';
import type { Rgb } from '../../src/core/color/srgb';
import { decodeSrgb, encodeSrgbClamped } from '../../src/core/color/transfer';
import { seededRandom } from '../core/color/helpers';

export interface GoldenImage {
  name: string;
  width: number;
  height: number;
  /** RGBA 8 бит, строки сверху вниз. */
  data: Uint8ClampedArray;
}

function image(name: string, width: number, height: number, color: (x: number, y: number) => Rgb): GoldenImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      const i = (y * width + x) * 4;
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  return { name, width, height, data };
}

/** OKLab → sRGB с поканальным срезом в охват. */
function fromOklab(L: number, a: number, b: number): Rgb {
  return encodeSrgbClamped(oklabToLinearSrgb([L, a, b]));
}

/** Рампы 0..1: серая, основные и дополнительные цвета, тёплая. */
function ramps(): GoldenImage {
  const rows: ((v: number) => Rgb)[] = [
    (v) => [v, v, v],
    (v) => [v, 0, 0],
    (v) => [0, v, 0],
    (v) => [0, 0, v],
    (v) => [0, v, v],
    (v) => [v, 0, v],
    (v) => [v, v, 0],
    (v) => [v, v * 0.8, v * 0.6],
  ];
  return image('рампы', 256, rows.length, (x, y) => (rows[y] as (v: number) => Rgb)(x / 255));
}

/** Круг тонов OKLCH при нескольких светлотах и хромах. */
function hueCircle(): GoldenImage {
  const levels: [number, number][] = [];
  for (const L of [0.35, 0.55, 0.75, 0.9]) for (const C of [0.03, 0.08, 0.15]) levels.push([L, C]);
  return image('круг тонов', 360, levels.length, (x, y) => {
    const [L, C] = levels[y] as [number, number];
    const [, a, b] = oklchToOklab([L, C, x]);
    return fromOklab(L, a, b);
  });
}

/** Телесные тона от светлого до тёмного, каждый в трёх экспозициях. */
function skin(): GoldenImage {
  const tones = ['ffdbac', 'f1c27d', 'e0ac69', 'c68642', '8d5524', 'd8a48f', 'b07a62', 'e8b9a0', 'a0674b', '5c3a2e', 'f3d1c0', 'c99a7b'];
  return image('кожа', tones.length * 8, 24, (x, y) => {
    const hex = tones[Math.floor(x / 8)] as string;
    const base: Rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
    const k = [0.6, 1, 1.4][Math.floor(y / 8)] as number;
    const lin = decodeSrgb(base);
    return encodeSrgbClamped([lin[0] * k, lin[1] * k, lin[2] * k]);
  });
}

/** Почти серые: рампа L с крошечными сдвигами a и b — тут ошибки тона заметнее всего. */
function nearNeutral(): GoldenImage {
  const offsets: [number, number][] = [
    [0, 0],
    [0.004, 0],
    [-0.004, 0],
    [0, 0.004],
    [0, -0.004],
    [0.008, 0.008],
    [-0.008, 0.008],
    [0.008, -0.008],
    [-0.008, -0.008],
  ];
  return image('почти серые', 64, offsets.length, (x, y) => {
    const [a, b] = offsets[y] as [number, number];
    return fromOklab(0.05 + (0.95 * x) / 63, a, b);
  });
}

/** Решётка 17³ по кубу RGB, включая углы и грани. */
function lattice(): GoldenImage {
  return image('куб RGB', 17 * 17, 17, (x, y) => [(x % 17) / 16, Math.floor(x / 17) / 16, y / 16]);
}

/** Случайные цвета. */
function noise(): GoldenImage {
  const random = seededRandom(2026);
  return image('шум', 64, 64, () => [random(), random(), random()]);
}

export function goldenImages(): GoldenImage[] {
  return [ramps(), hueCircle(), skin(), nearNeutral(), lattice(), noise()];
}
