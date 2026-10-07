// Критерий этапа 1: шейдер совпадает с эталоном core/color/pipeline.ts на наборе эталонных изображений —
// средний ΔE2000 < 0.5, максимум < 2. Шейдер рисует в Electron на скрытой странице parity.html.
// Этап 2б: то же для режимов просмотра 3 и 4 (core/color/view.ts). В режиме 3 пороги прежние; в режиме 4
// сверяется номер уровня, и расхождение допустимо только у пикселей, чьё L ближе 10⁻⁴ к границе уровня.
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

const ROOT = join(__dirname, '../..');
const MEAN_LIMIT = 0.5;
const MAX_LIMIT = 2;
/** Режим 4: у пикселей ближе этого к границе уровня float32 на GPU может выбрать соседний уровень. */
const LEVEL_BOUNDARY_TOLERANCE = 1e-4;

/** То, что parity.ts кладёт в window. */
interface ParityWindow {
  gridtoneParity: { render(width: number, height: number, rgba8: string, params: PipelineParams, view: ViewOutput): string };
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

test('шейдер совпадает с эталоном core на эталонных изображениях, в том числе в режимах 3 и 4', async () => {
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
    const render = (image: GoldenImage, rgba8: string, params: PipelineParams, view: ViewOutput) =>
      page
        .evaluate(
          ([w, h, data, p, v]) => (globalThis as unknown as ParityWindow).gridtoneParity.render(w, h, data, p, v),
          [image.width, image.height, rgba8, params, view] as const,
        )
        .then((output) => new Float32Array(new Uint8Array(Buffer.from(output, 'base64')).buffer));
    for (const image of goldenImages()) {
      const rgba8 = Buffer.from(image.data).toString('base64');
      for (const { name, params } of parityCases()) {
        for (const view of ['color', 'luminance'] as const) {
          const stats = compare(image, params, await render(image, rgba8, params, view), view);
          const label = `${view === 'color' ? '' : 'яркость: '}${name}`;
          rows.push(`${image.name.padEnd(12)} ${label.padEnd(44)} средний ${stats.mean.toFixed(4)}  максимум ${stats.max.toFixed(4)}`);
          if (stats.mean >= MEAN_LIMIT || stats.max >= MAX_LIMIT) {
            failures.push(`${image.name} / ${label}: средний ${stats.mean.toFixed(3)}, максимум ${stats.max.toFixed(3)}; худший пиксель ${stats.worst}`);
          }
        }
        const levels = compareLevels(image, params, await render(image, rgba8, params, 'posterize'));
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
