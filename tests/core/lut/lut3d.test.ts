import { describe, expect, it } from 'vitest';
import { createLut, identityLut, lutIndex, sampleLut, type Lut3D, type LutInterpolation } from '@core/lut/lut3d';
import type { Rgb } from '@core/color/srgb';
import { randomColors, seededRandom } from '../color/helpers';

const INTERPOLATIONS: LutInterpolation[] = ['tetrahedral', 'trilinear'];

/** Аффинная функция с перемешиванием каналов: её любая из двух интерполяций воспроизводит точно. */
const affine = (c: Rgb): Rgb => [
  0.2 + 0.5 * c[0] - 0.3 * c[1] + 0.1 * c[2],
  -0.1 + 0.2 * c[0] + 0.9 * c[1],
  0.05 - 0.4 * c[0] + 0.25 * c[1] + 1.1 * c[2],
];

/** LUT со случайными значениями в узлах: на нём видна любая ошибка выбора тетраэдра. */
function randomLut(size: number, seed: number): Lut3D {
  const random = seededRandom(seed);
  return createLut(size, () => [random(), random(), random()]);
}

function expectClose(a: Rgb, b: Rgb, digits: number): void {
  for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c] as number, digits);
}

describe('Lut3D', () => {
  it('R меняется быстрее всех, затем G, затем B — как в .cube', () => {
    expect(lutIndex(5, 0, 0, 0)).toBe(0);
    expect(lutIndex(5, 1, 0, 0)).toBe(3);
    expect(lutIndex(5, 0, 1, 0)).toBe(15);
    expect(lutIndex(5, 0, 0, 1)).toBe(75);
    const lut = identityLut(3);
    expect(Array.from(lut.data.subarray(0, 9))).toEqual([0, 0, 0, 0.5, 0, 0, 1, 0, 0]);
    expect(Array.from(lut.data.subarray(9, 12))).toEqual([0, 0.5, 0]);
    expect(lut.data.length).toBe(27 * 3);
  });

  it('узел решётки получает f от своего входа, с учётом домена', () => {
    const lut = createLut(4, (c) => c, { min: [-0.1, 0, 0.2], max: [1.2, 1, 0.8] });
    const i = lutIndex(4, 3, 1, 2);
    expect(lut.data[i]).toBeCloseTo(1.2, 12);
    expect(lut.data[i + 1]).toBeCloseTo(1 / 3, 12);
    expect(lut.data[i + 2]).toBeCloseTo(0.2 + (0.6 * 2) / 3, 12);
  });

  for (const interpolation of INTERPOLATIONS) {
    describe(interpolation, () => {
      it('точна в узлах', () => {
        for (const size of [2, 5, 17, 33]) {
          const lut = randomLut(size, size);
          const random = seededRandom(size + 1);
          for (let k = 0; k < 300; k++) {
            const [r, g, b] = [0, 0, 0].map(() => Math.floor(random() * size)) as Rgb;
            const i = lutIndex(size, r, g, b);
            const node: Rgb = [lut.data[i] as number, lut.data[i + 1] as number, lut.data[i + 2] as number];
            const input: Rgb = [r / (size - 1), g / (size - 1), b / (size - 1)];
            expectClose(sampleLut(lut, input, interpolation), node, 12);
          }
        }
      });

      it('на решётке 33 и 65 узлы возвращаются бит в бит', () => {
        for (const size of [33, 65]) {
          const lut = randomLut(size, 7);
          for (const [r, g, b] of [
            [0, 0, 0],
            [size - 1, size - 1, size - 1],
            [3, 17, size - 1],
            [size - 1, 0, 9],
          ] as Rgb[]) {
            const i = lutIndex(size, r, g, b);
            expect(sampleLut(lut, [r / (size - 1), g / (size - 1), b / (size - 1)], interpolation)).toEqual([
              lut.data[i],
              lut.data[i + 1],
              lut.data[i + 2],
            ]);
          }
        }
      });

      it('воспроизводит аффинную функцию между узлами', () => {
        const lut = createLut(5, affine);
        for (const c of randomColors(2000, 11)) expectClose(sampleLut(lut, c, interpolation), affine(c), 12);
      });

      it('домен: вход переводится в решётку, вне домена — срез', () => {
        const domain = { min: [-0.1, -0.1, -0.1] as Rgb, max: [1.2, 1.2, 1.2] as Rgb };
        const lut = createLut(9, affine, domain);
        for (const c of randomColors(500, 12)) {
          const inside = c.map((v) => -0.1 + v * 1.3) as Rgb;
          expectClose(sampleLut(lut, inside, interpolation), affine(inside), 12);
        }
        expectClose(sampleLut(lut, [-1, 0.5, 2], interpolation), affine([-0.1, 0.5, 1.2]), 12);
      });

      it('непрерывна на гранях ячеек', () => {
        const lut = randomLut(9, 3);
        const random = seededRandom(4);
        const eps = 1e-9;
        for (let k = 0; k < 500; k++) {
          const c = [random(), random(), random()] as Rgb;
          const axis = (k % 3) as 0 | 1 | 2;
          // Точка на грани ячейки по одной из осей.
          c[axis] = Math.floor(random() * 7 + 1) / 8;
          const below = [...c] as Rgb;
          const above = [...c] as Rgb;
          below[axis] = c[axis] - eps;
          above[axis] = c[axis] + eps;
          const a = sampleLut(lut, below, interpolation);
          const b = sampleLut(lut, above, interpolation);
          for (let ch = 0; ch < 3; ch++) expect(Math.abs((a[ch] as number) - (b[ch] as number))).toBeLessThan(1e-6);
        }
      });
    });
  }

  it('тетраэдрическая непрерывна на гранях тетраэдров внутри ячейки', () => {
    const lut = randomLut(5, 21);
    const random = seededRandom(22);
    const eps = 1e-9;
    // Грани внутри ячейки — плоскости fr = fg, fg = fb, fr = fb.
    const pairs: [number, number][] = [
      [0, 1],
      [1, 2],
      [0, 2],
    ];
    for (let k = 0; k < 600; k++) {
      const [i, j] = pairs[k % 3] as [number, number];
      const cell = [0, 0, 0].map(() => Math.floor(random() * 4)) as Rgb;
      const f = [random(), random(), random()];
      f[j] = f[i] as number;
      const at = (df: number): Rgb =>
        cell.map((c, ch) => (c + (f[ch] as number) + (ch === i ? df : 0)) / 4) as Rgb;
      const a = sampleLut(lut, at(-eps), 'tetrahedral');
      const b = sampleLut(lut, at(eps), 'tetrahedral');
      for (let ch = 0; ch < 3; ch++) expect(Math.abs((a[ch] as number) - (b[ch] as number))).toBeLessThan(1e-6);
    }
  });

  it('тетраэдрическая и трилинейная различаются только внутри ячейки', () => {
    const lut = randomLut(5, 31);
    // На ребре ячейки обе — линейная интерполяция между двумя узлами.
    expectClose(sampleLut(lut, [0.1, 0.25, 0.5], 'tetrahedral'), sampleLut(lut, [0.1, 0.25, 0.5], 'trilinear'), 12);
    const inside: Rgb = [0.1, 0.33, 0.6];
    const t = sampleLut(lut, inside, 'tetrahedral');
    const l = sampleLut(lut, inside, 'trilinear');
    expect(Math.max(...t.map((v, c) => Math.abs(v - (l[c] as number))))).toBeGreaterThan(1e-3);
  });

  it('тетраэдрическая сохраняет серую ось: серый вход берёт только узлы диагонали', () => {
    // Узлы вне диагонали испорчены — серый вход их не видит.
    const lut = createLut(5, (c) => (c[0] === c[1] && c[1] === c[2] ? c : [9, 9, 9]));
    for (let v = 0; v <= 1; v += 0.01) expectClose(sampleLut(lut, [v, v, v], 'tetrahedral'), [v, v, v], 12);
    // Трилинейная смешивает все восемь узлов ячейки.
    expect(sampleLut(lut, [0.1, 0.1, 0.1], 'trilinear')[0]).toBeGreaterThan(1);
  });
});
