// Критерий этапа 1: шейдер совпадает с эталоном core/color/pipeline.ts на наборе эталонных изображений —
// средний ΔE2000 < 0.5, максимум < 2. Шейдер рисует в Electron на скрытой странице parity.html.
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { bakePipeline, type PipelineParams } from '../../src/core/color/bake';
import { deltaE2000, srgbToCielab } from '../../src/core/color/deltaE';
import { applyBaked } from '../../src/core/color/pipeline';
import { parityCases } from '../golden/cases';
import { goldenImages, type GoldenImage } from '../golden/images';

const ROOT = join(__dirname, '../..');
const MEAN_LIMIT = 0.5;
const MAX_LIMIT = 2;

/** То, что parity.ts кладёт в window. */
interface ParityWindow {
  gridtoneParity: { render(width: number, height: number, rgba8: string, params: PipelineParams): string };
}

interface Stats {
  mean: number;
  max: number;
  worst: string;
}

function compare(image: GoldenImage, params: PipelineParams, gpu: Float32Array): Stats {
  const baked = bakePipeline(params);
  let sum = 0;
  let max = 0;
  let worst = '';
  const { data, width } = image;
  for (let i = 0; i < data.length; i += 4) {
    const input: [number, number, number] = [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255];
    const cpu = applyBaked(input, baked);
    const shader: [number, number, number] = [gpu[i]!, gpu[i + 1]!, gpu[i + 2]!];
    const d = deltaE2000(srgbToCielab(cpu), srgbToCielab(shader));
    sum += d;
    if (d > max) {
      max = d;
      const p = i / 4;
      const fmt = (c: number[]) => c.map((v) => v.toFixed(4)).join(', ');
      worst = `(${p % width}, ${Math.floor(p / width)}) вход ${fmt(input)} → core ${fmt(cpu)}, шейдер ${fmt(shader)}`;
    }
  }
  return { mean: sum / (data.length / 4), max, worst };
}

test('шейдер совпадает с эталоном core на эталонных изображениях', async () => {
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
    for (const image of goldenImages()) {
      const rgba8 = Buffer.from(image.data).toString('base64');
      for (const { name, params } of parityCases()) {
        const output = await page.evaluate(
          ([w, h, data, p]) => (globalThis as unknown as ParityWindow).gridtoneParity.render(w, h, data, p),
          [image.width, image.height, rgba8, params] as const,
        );
        const gpu = new Float32Array(new Uint8Array(Buffer.from(output, 'base64')).buffer);
        const stats = compare(image, params, gpu);
        rows.push(`${image.name.padEnd(12)} ${name.padEnd(34)} средний ${stats.mean.toFixed(4)}  максимум ${stats.max.toFixed(4)}`);
        if (stats.mean >= MEAN_LIMIT || stats.max >= MAX_LIMIT) {
          failures.push(`${image.name} / ${name}: средний ${stats.mean.toFixed(3)}, максимум ${stats.max.toFixed(3)}; худший пиксель ${stats.worst}`);
        }
      }
    }
    console.log(rows.join('\n'));
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await app.close();
  }
});
