// Критерий этапа 3а: образ экспортируется в .cube 33 или 65 и в HaldCLUT; файл, применённый к фото,
// даёт то же, что плитка в сетке; проверка по кругу проходит порог спеки, а если 33 не проходит —
// экспорт берёт 65. «Редактор» здесь — сам тест: он применяет файл тетраэдрической интерполяцией core,
// как Photoshop (план этапа 3). Настоящие редакторы — ручной чек-лист.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { bakePipeline } from '../../src/core/color/bake';
import { oklabToLinearSrgb, oklchToOklab } from '../../src/core/color/oklab';
import { applyBaked } from '../../src/core/color/pipeline';
import type { Rgb as Rgb01 } from '../../src/core/color/srgb';
import { encodeSrgbClamped } from '../../src/core/color/transfer';
import { lookPipeline } from '../../src/core/lut/bake';
import { sampleLut, type Lut3D } from '../../src/core/lut/lut3d';
import { checkLut, lutErrors, summarizeErrors, LUT_CHECK_LIMITS } from '../../src/core/lut/verify';
import type { Adjust, Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { readCube, readHald } from '../fixtures/lut';
import { filmLook, kinkLook } from '../golden/looks';
import { expectTilesRendered, launch, regionColor, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e3a-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const W = 900;
const H = 1200;

function oklch(L: number, C: number, h: number): Rgb {
  const [r, g, b] = encodeSrgbClamped(oklabToLinearSrgb(oklchToOklab([L, C, h])));
  return { r: r * 255, g: g * 255, b: b * 255 };
}

/** Сверху круг тонов OKLCH слева направо, снизу серая рампа. */
const huesAndRamp = (u: number, v: number): Rgb => (v < 0.5 ? oklch(0.68, 0.12, u * 360) : { r: u * 255, g: u * 255, b: u * 255 });

/** Девять телесных тонов квадратами 3 × 3. */
const SKIN = ['ffdbac', 'f1c27d', 'e0ac69', 'c68642', '8d5524', 'd8a48f', 'b07a62', 'e8b9a0', '5c3a2e'];
const skin = (u: number, v: number): Rgb => {
  const hex = SKIN[Math.min(2, Math.floor(v * 3)) * 3 + Math.min(2, Math.floor(u * 3))] as string;
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
};

/** Три области каждой плитки, доли ширины и высоты: в них цвет меняется плавно или не меняется. */
const REGIONS: [number, number][][][] = [
  [
    [
      [0.05, 0.3],
      [0.1, 0.4],
    ],
    [
      [0.6, 0.9],
      [0.1, 0.4],
    ],
    [
      [0.3, 0.7],
      [0.6, 0.9],
    ],
  ],
  [
    [
      [0.05, 0.28],
      [0.05, 0.28],
    ],
    [
      [0.39, 0.61],
      [0.39, 0.61],
    ],
    [
      [0.72, 0.95],
      [0.72, 0.95],
    ],
  ],
];

interface Proxy {
  width: number;
  height: number;
  /** RGB 0..1 подряд. */
  colors: Float64Array;
}

/** Прокси 512 так, как его читает core. */
async function readProxy(projectDir: string, assetId: string): Promise<Proxy> {
  const { data, info } = await sharp(join(projectDir, 'cache', 'proxies', assetId, '512.jpg'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, colors: Float64Array.from(data, (v) => v / 255) };
}

/** Средний цвет области прокси после LUT, 0..255. Выход срезается в 0..1, как у редактора. */
function regionThroughLut(proxy: Proxy, lut: Lut3D, [x0, x1]: [number, number], [y0, y1]: [number, number]) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(y0 * proxy.height); y < Math.ceil(y1 * proxy.height); y++) {
    for (let x = Math.floor(x0 * proxy.width); x < Math.ceil(x1 * proxy.width); x++) {
      const i = (y * proxy.width + x) * 3;
      const out = sampleLut(lut, [proxy.colors[i]!, proxy.colors[i + 1]!, proxy.colors[i + 2]!]);
      for (let c = 0; c < 3; c++) sum[c]! += Math.min(1, Math.max(0, out[c]!)) * 255;
      n++;
    }
  }
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

/** Каждый пиксель прокси через LUT против конвейера core с образом: ΔE2000 средний и 99-й перцентиль. */
function proxyErrors(proxy: Proxy, lut: Lut3D, look: Adjust) {
  const baked = bakePipeline(lookPipeline(look));
  const { errors } = lutErrors(lut, (c: Rgb01) => applyBaked(c, baked), proxy.colors, ['tetrahedral']);
  return summarizeErrors(errors[0]!);
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** Нажимает «Экспортировать…» и ждёт итога. Возвращает новую подпапку. */
async function runExport(dialog: Locator): Promise<string> {
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true');
  await expect(result).toContainText('Готово');
  return (await result.getAttribute('data-dir')) ?? '';
}

test('образ экспортируется в .cube и HaldCLUT; файл, применённый к фото, даёт плитку; 33 или 65 по проверке', async () => {
  const photos = join(root, 'photos');
  const files = [await writePixelFixture(photos, '1-hues', W, H, huesAndRamp), await writePixelFixture(photos, '2-skin', W, H, skin)];
  const projectDir = join(root, 'Стиль');

  // Проект с двумя фото.
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 2');
  await expectTilesRendered(page, 2);
  await app.close();
  app = undefined;

  // Образы в фикстуре: «Плёнка» на обеих плитках, «Излом» ни на одной. Поправка фото нейтральна.
  const film = filmLook();
  const kink = kinkLook();
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  project.looks = [
    { id: 'look-film', name: 'Плёнка', adjust: film },
    { id: 'look-kink', name: 'Излом', adjust: kink },
  ];
  for (const slot of project.slots) slot.lookId = 'look-film';
  await writeFile(file, JSON.stringify(project, null, 2));

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  const ids = await expectTilesRendered(page, 2);
  const tiles = page.getByTestId('tile');
  // Плитки на экране — до диалога: его подложка затемняет окно.
  const screen: { r: number; g: number; b: number }[][] = [];
  for (const [t, regions] of REGIONS.entries()) {
    screen.push([]);
    for (const [x, y] of regions) screen[t]!.push(await regionColor(tiles.nth(t), x!, y!));
  }

  // «Экспорт» → раздел LUT: «Плёнка» отмечен и проходит на 33; «Излом» на 33 не проходит, выбран 65.
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const row = (name: string) => dialog.locator(`[data-testid="lut-look"][data-name="${name}"]`);
  await expect(row('Плёнка').getByRole('checkbox', { name: 'Плёнка' })).toBeChecked();
  await expect(row('Плёнка').getByTestId('lut-check')).toHaveAttribute('data-state', 'pass');
  await expect(row('Плёнка').getByTestId('lut-check')).toContainText('33: подходит');
  await expect(row('Плёнка').getByRole('radio', { name: '33' })).toBeChecked();
  await expect(row('Излом').getByRole('checkbox', { name: 'Излом' })).toBeChecked();
  await expect(row('Излом').getByTestId('lut-check')).toHaveAttribute('data-state', 'fail');
  await expect(row('Излом').getByTestId('lut-check')).toHaveAttribute('data-state65', 'pass');
  await expect(row('Излом').getByTestId('lut-check')).toContainText('33: не подходит');
  await expect(row('Излом').getByTestId('lut-check')).toContainText('65: подходит');
  await expect(row('Излом').getByRole('radio', { name: '65' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '.cube' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'HaldCLUT PNG' })).toBeChecked();

  // Папка — из подменённого диалога; экспорт пишет в новую подпапку.
  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  const first = await runExport(dialog);
  expect(await readdir(exportRoot)).toHaveLength(1);
  expect(first.startsWith(join(exportRoot, 'Стиль — экспорт '))).toBe(true);
  expect((await readdir(first)).sort()).toEqual(['Излом.cube', 'Излом.png', 'Плёнка.cube', 'Плёнка.png']);
  for (const name of ['Плёнка.cube', 'Плёнка.png', 'Излом.cube', 'Излом.png']) await expect(dialog.getByTestId('export-result')).toContainText(name);

  const filmText = await readFile(join(first, 'Плёнка.cube'), 'utf8');
  expect(filmText).toContain('\nTITLE "Плёнка"\n');
  expect(filmText).toContain('\nLUT_3D_SIZE 33\n');
  const filmCube = await readCube(join(first, 'Плёнка.cube'));
  const filmHald = await readHald(join(first, 'Плёнка.png'));
  expect([filmHald.width, filmHald.height, filmHald.depth, filmHald.hasProfile]).toEqual([512, 512, 'ushort', false]);

  // .cube и HaldCLUT, применённые к прокси, дают плитку на экране и конвейер core.
  for (const [t, assetId] of ids.entries()) {
    const proxy = await readProxy(projectDir, assetId);
    for (const [k, [x, y]] of REGIONS[t]!.entries()) {
      const onScreen = screen[t]![k]!;
      for (const [label, lut] of [
        ['.cube', filmCube],
        ['HaldCLUT', filmHald.lut],
      ] as const) {
        const viaLut = regionThroughLut(proxy, lut, x!, y!);
        for (const c of ['r', 'g', 'b'] as const) {
          expect(
            Math.abs(onScreen[c] - viaLut[c]),
            `плитка ${t + 1}, область ${x}×${y}, ${label}: экран ${onScreen[c].toFixed(1)}, LUT ${viaLut[c].toFixed(1)}`,
          ).toBeLessThanOrEqual(3);
        }
      }
    }
    for (const lut of [filmCube, filmHald.lut]) {
      const stats = proxyErrors(proxy, lut, film);
      expect(stats.mean, `плитка ${t + 1}: средний ΔE2000`).toBeLessThan(LUT_CHECK_LIMITS.mean);
      expect(stats.p99, `плитка ${t + 1}: 99-й перцентиль ΔE2000`).toBeLessThan(LUT_CHECK_LIMITS.p99);
    }
  }

  // «Излом»: в файле 65 узлов, порог пройден — и на наборе проверки, и на прокси.
  const kinkText = await readFile(join(first, 'Излом.cube'), 'utf8');
  expect(kinkText).toContain('\nLUT_3D_SIZE 65\n');
  const kinkCube = await readCube(join(first, 'Излом.cube'));
  const kinkBaked = bakePipeline(lookPipeline(kink));
  expect(checkLut(kinkCube, (c) => applyBaked(c, kinkBaked)).pass).toBe(true);
  const kinkStats = proxyErrors(await readProxy(projectDir, ids[0]!), kinkCube, kink);
  expect(kinkStats.p99).toBeLessThan(LUT_CHECK_LIMITS.p99);

  // Повторный экспорт — вторая подпапка, первая не тронута.
  const before = new Map<string, { hash: string; mtime: number }>();
  for (const name of await readdir(first)) {
    before.set(name, { hash: await sha256(join(first, name)), mtime: (await stat(join(first, name))).mtimeMs });
  }
  const second = await runExport(dialog);
  expect(second).not.toBe(first);
  expect(await readdir(exportRoot)).toHaveLength(2);
  expect((await readdir(second)).sort()).toEqual(['Излом.cube', 'Излом.png', 'Плёнка.cube', 'Плёнка.png']);
  expect((await readdir(first)).sort()).toEqual([...before.keys()].sort());
  for (const [name, { hash, mtime }] of before) {
    expect(await sha256(join(first, name))).toBe(hash);
    expect((await stat(join(first, name))).mtimeMs).toBe(mtime);
  }
  // Запекание детерминировано: файлы второго экспорта те же.
  expect(await sha256(join(second, 'Плёнка.cube'))).toBe(before.get('Плёнка.cube')?.hash);

  // Esc закрывает диалог.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
