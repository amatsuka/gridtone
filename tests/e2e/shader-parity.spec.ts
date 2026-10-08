// Критерий этапа 1: шейдер совпадает с эталоном core/color/pipeline.ts на наборе эталонных изображений —
// средний ΔE2000 < 0.5, максимум < 2. Шейдер рисует в Electron на скрытой странице parity.html.
// Этап 2б: то же для режимов просмотра 3 и 4 (core/color/view.ts). В режиме 3 пороги прежние; в режиме 4
// сверяется номер уровня, и расхождение допустимо только у пикселей, чьё L ближе 10⁻⁴ к границе уровня.
// Этап 3б: шаг 9 — импортированный LUT образа — на синтетических LUT, с коррекцией образа и без неё.
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { bakePipeline, type PipelineParams } from '../../src/core/color/bake';
import { deltaE2000, srgbToCielab } from '../../src/core/color/deltaE';
import { applyBaked } from '../../src/core/color/pipeline';
import type { Rgb } from '../../src/core/color/srgb';
import {
  applyView,
  grayOfL,
  levelL,
  oklabL,
  POSTERIZE_BOUNDARIES,
  POSTERIZE_LEVELS,
  posterizeLevel,
  type ViewOutput,
} from '../../src/core/color/view';
import { parityCases } from '../golden/cases';
import { goldenImages, type GoldenImage } from '../golden/images';
import { lutParityCases, parityLuts } from '../golden/luts';

const ROOT = join(__dirname, '../..');
const MEAN_LIMIT = 0.5;
const MAX_LIMIT = 2;
/** Режим 4: у пикселей ближе этого к границе уровня float32 на GPU может выбрать соседний уровень. */
const LEVEL_BOUNDARY_TOLERANCE = 1e-4;

/** LUT для страницы сверки — как ParityLut в parity.ts: узлы float64 подряд в base64. */
interface ParityLut {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: string;
}

/** То, что parity.ts кладёт в window. */
interface ParityWindow {
  gridtoneParity: {
    loadLut(id: string, lut: ParityLut): void;
    render(width: number, height: number, rgba8: string, params: PipelineParams, view: ViewOutput, lutId?: string): string;
  };
}

interface Stats {
  mean: number;
  max: number;
  worst: string;
}

const fmt = (c: readonly number[]) => c.map((v) => v.toFixed(4)).join(', ');

/** Режимы 2 и 3: ΔE2000 между core и шейдером по каждому пикселю. */
function compare(image: GoldenImage, params: PipelineParams, gpu: Float32Array, view: 'color' | 'luminance'): Stats {
  const baked = bakePipeline(params);
  let sum = 0;
  let max = 0;
  let worst = '';
  const { data, width } = image;
  for (let i = 0; i < data.length; i += 4) {
    const input: [number, number, number] = [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255];
    const cpu = applyView(applyBaked(input, baked), view);
    const shader: [number, number, number] = [gpu[i]!, gpu[i + 1]!, gpu[i + 2]!];
    const d = deltaE2000(srgbToCielab(cpu), srgbToCielab(shader));
    sum += d;
    if (d > max) {
      max = d;
      const p = i / 4;
      worst = `(${p % width}, ${Math.floor(p / width)}) вход ${fmt(input)} → core ${fmt(cpu)}, шейдер ${fmt(shader)}`;
    }
  }
  return { mean: sum / (data.length / 4), max, worst };
}

interface LevelStats {
  /** Пиксели, где уровень разошёлся дальше допуска от границы, и описание первого из них. */
  wrong: number;
  firstWrong: string;
  /** Пиксели у самой границы уровня, где расхождение допустимо. */
  nearBoundary: number;
}

/** Серые уровней на выходе шейдера. */
const LEVEL_GRAYS = Array.from({ length: POSTERIZE_LEVELS }, (_, k) => grayOfL(levelL(k))[0]);

/** Режим 4: номер уровня по core против уровня, который нарисовал шейдер. */
function compareLevels(image: GoldenImage, params: PipelineParams, gpu: Float32Array): LevelStats {
  const baked = bakePipeline(params);
  const stats: LevelStats = { wrong: 0, firstWrong: '', nearBoundary: 0 };
  const { data, width } = image;
  for (let i = 0; i < data.length; i += 4) {
    const input: Rgb = [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255];
    const L = oklabL(applyBaked(input, baked));
    const expected = posterizeLevel(L);
    const [r, g, b] = [gpu[i]!, gpu[i + 1]!, gpu[i + 2]!];
    let level = 0;
    LEVEL_GRAYS.forEach((v, k) => {
      if (Math.abs(r - v) < Math.abs(r - (LEVEL_GRAYS[level] as number))) level = k;
    });
    const gray = r === g && g === b && Math.abs(r - (LEVEL_GRAYS[level] as number)) < 1e-4;
    if (gray && level === expected) continue;
    const boundary = Math.min(...POSTERIZE_BOUNDARIES.map((edge) => Math.abs(L - edge)));
    if (gray && Math.abs(level - expected) === 1 && boundary < LEVEL_BOUNDARY_TOLERANCE) {
      stats.nearBoundary++;
      continue;
    }
    if (stats.wrong++ === 0) {
      const p = i / 4;
      stats.firstWrong = `(${p % width}, ${Math.floor(p / width)}) вход ${fmt(input)}, L ${L.toFixed(6)} → уровень ${expected}, шейдер ${fmt([r, g, b])}`;
    }
  }
  return stats;
}

test('шейдер совпадает с эталоном core на эталонных изображениях, в режимах 3 и 4 и с LUT образа', async () => {
  const app = await electron.launch({ args: ['.'], cwd: ROOT });
  try {
    await app.firstWindow();
    const [page] = await Promise.all([
      app.waitForEvent('window'),
      app.evaluate(({ BrowserWindow }, file) => {
        const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        void window.loadFile(file);
      }, join(ROOT, 'out/renderer/parity.html')),
    ]);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForFunction(() => 'gridtoneParity' in globalThis, undefined, { timeout: 15_000 }).catch(() => {
      throw new Error(`Страница сверки не загрузилась: ${errors.join('; ')}`);
    });

    const failures: string[] = [];
    const rows: string[] = [];
    const render = (image: GoldenImage, rgba8: string, params: PipelineParams, view: ViewOutput, lutId?: string) =>
      page
        .evaluate(
          ([w, h, data, p, v, id]) => (globalThis as unknown as ParityWindow).gridtoneParity.render(w, h, data, p, v, id),
          [image.width, image.height, rgba8, params, view, lutId] as const,
        )
        .then((output) => new Float32Array(new Uint8Array(Buffer.from(output, 'base64')).buffer));

    // LUT грузятся на страницу один раз; core получает тот же LUT в params.lut.
    const luts = parityLuts();
    for (const [id, lut] of Object.entries(luts)) {
      const data = Buffer.from(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength).toString('base64');
      const payload: ParityLut = { size: lut.size, domainMin: lut.domainMin, domainMax: lut.domainMax, data };
      await page.evaluate(([i, l]) => (globalThis as unknown as ParityWindow).gridtoneParity.loadLut(i, l), [id, payload] as const);
    }
    const cases = [
      ...parityCases().map(({ name, params }) => ({ name, params, lutId: undefined as string | undefined })),
      ...lutParityCases(),
    ];

    for (const image of goldenImages()) {
      const rgba8 = Buffer.from(image.data).toString('base64');
      for (const { name, params, lutId } of cases) {
        const cpuParams: PipelineParams = lutId === undefined ? params : { ...params, lut: luts[lutId] };
        for (const view of ['color', 'luminance'] as const) {
          const stats = compare(image, cpuParams, await render(image, rgba8, params, view, lutId), view);
          const label = `${view === 'color' ? '' : 'яркость: '}${name}`;
          rows.push(`${image.name.padEnd(12)} ${label.padEnd(44)} средний ${stats.mean.toFixed(4)}  максимум ${stats.max.toFixed(4)}`);
          if (stats.mean >= MEAN_LIMIT || stats.max >= MAX_LIMIT) {
            failures.push(`${image.name} / ${label}: средний ${stats.mean.toFixed(3)}, максимум ${stats.max.toFixed(3)}; худший пиксель ${stats.worst}`);
          }
        }
        const levels = compareLevels(image, cpuParams, await render(image, rgba8, params, 'posterize', lutId));
        const label = `постеризация: ${name}`;
        rows.push(`${image.name.padEnd(12)} ${label.padEnd(44)} не тот уровень ${levels.wrong}, у границы ${levels.nearBoundary}`);
        if (levels.wrong > 0) failures.push(`${image.name} / ${label}: не тот уровень у ${levels.wrong} пикс.; первый ${levels.firstWrong}`);
      }
    }
    console.log(rows.join('\n'));
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await app.close();
  }
});
