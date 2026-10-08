// Критерий этапа 3б: импортированный `.cube` становится образом проекта; шаг 9 в шейдере совпадает с core
// (сверка — в shader-parity.spec.ts); плитка, редактор фото и режим 5 показывают образ с LUT; LUT переживает
// перезапуск, перенос папки проекта и отмену удаления образа. docs/decisions/0015-lut-import.md.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { bakeAdjust, bakePipeline, type BakedPipeline } from '../../src/core/color/bake';
import { deltaE2000, srgbToCielab } from '../../src/core/color/deltaE';
import { applyBaked, applyLutStep, applyPass } from '../../src/core/color/pipeline';
import type { Rgb as Rgb01 } from '../../src/core/color/srgb';
import { lookPipeline } from '../../src/core/lut/bake';
import { parseCube, writeCube } from '../../src/core/lut/cube';
import { sampleLut, type Lut3D } from '../../src/core/lut/lut3d';
import { checkLut } from '../../src/core/lut/verify';
import { labToSrgb8, tileMetrics } from '../../src/core/metrics/tile';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Adjust } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { readCube } from '../fixtures/lut';
import { sepiaLut } from '../golden/luts';
import { backgroundColor, expectTilesRendered, launch, mainProject, press, regionColor, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e3b-'));
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
const BLUE: Rgb = { r: 40, g: 80, b: 200 };
const RED: Rgb = { r: 200, g: 60, b: 50 };
/** Серая рампа слева направо. */
const ramp = (u: number): Rgb => ({ r: u * 255, g: u * 255, b: u * 255 });

/** Области рампы: тени, середина и света — в светах экспозиция до и после LUT расходятся сильнее всего. */
const RAMP_REGIONS: [[number, number], [number, number]][] = [
  [
    [0.1, 0.25],
    [0.3, 0.7],
  ],
  [
    [0.45, 0.55],
    [0.3, 0.7],
  ],
  [
    [0.7, 0.85],
    [0.3, 0.7],
  ],
];
const CENTER: [[number, number], [number, number]] = [
  [0.3, 0.7],
  [0.3, 0.7],
];

type Color = { r: number; g: number; b: number };

interface Proxy {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Прокси 512 так, как его читает core. */
async function readProxy(projectDir: string, assetId: string): Promise<Proxy> {
  const { data, info } = await sharp(join(projectDir, 'cache', 'proxies', assetId, '512.jpg'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Средний цвет области прокси после функции f, 0..255. Плитка 3:4 показывает фото 3:4 целиком. */
function regionThrough(proxy: Proxy, f: (c: Rgb01) => Rgb01, [x0, x1]: [number, number], [y0, y1]: [number, number]): Color {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(y0 * proxy.height); y < Math.ceil(y1 * proxy.height); y++) {
    for (let x = Math.floor(x0 * proxy.width); x < Math.ceil(x1 * proxy.width); x++) {
      const i = (y * proxy.width + x) * 4;
      const out = f([proxy.rgba[i]! / 255, proxy.rgba[i + 1]! / 255, proxy.rgba[i + 2]! / 255]);
      for (let c = 0; c < 3; c++) sum[c]! += Math.min(1, Math.max(0, out[c]!)) * 255;
      n++;
    }
  }
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

const through = (baked: BakedPipeline) => (c: Rgb01) => applyBaked(c, baked);

function maxDiff(a: Color, b: Color): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

const fmt = (c: Color) => `rgb(${c.r.toFixed(1)} ${c.g.toFixed(1)} ${c.b.toFixed(1)})`;

/** Плитка совпадает с ожиданием core (±tolerance из 255); ждёт, пока холст перерисуется. */
async function expectTile(tile: Locator, region: [[number, number], [number, number]], expected: Color, tolerance: number, label: string) {
  await expect
    .poll(async () => maxDiff(await regionColor(tile, ...region), expected), { message: `${label}: ожидалось ${fmt(expected)}` })
    .toBeLessThanOrEqual(tolerance);
}

/** Средний цвет квадрата 40 × 40 в центре элемента на экране. */
async function centerColor(page: Page, locator: Locator): Promise<Color> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('элемент не виден');
  const clip = { x: box.x + box.width / 2 - 20, y: box.y + box.height / 2 - 20, width: 40, height: 40 };
  const { data } = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
  const n = data.length / 3;
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

test('импортированный .cube — образ проекта: плитки, редактор, режим 5, экспорт, отмена, перенос папки, битые файлы', async () => {
  const photos = join(root, 'photos');
  const files = [
    await writePixelFixture(photos, '1-ramp', W, H, ramp),
    await writePixelFixture(photos, '2-blue', W, H, () => BLUE),
    await writePixelFixture(photos, '3-red', W, H, () => RED),
  ];
  // «Сепия» 17³ — известная функция; файл пишет тест, как его записал бы чужой редактор.
  const cubePath = join(root, 'luts-src', 'сепия.cube');
  await mkdir(join(root, 'luts-src'), { recursive: true });
  await writeFile(cubePath, writeCube(sepiaLut(), ['Синтетическая сепия для e2e']));
  const lut: Lut3D = parseCube(await readFile(cubePath, 'utf8'));
  const projectDir = join(root, 'Сепия-проект');

  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 3');
  const ids = await expectTilesRendered(page, 3);
  const tiles = page.getByTestId('tile');
  const proxies = await Promise.all(ids.map((id) => readProxy(projectDir, id)));

  // 1. «Импорт LUT…» во вкладке «Образ» создаёт образ «Сепия» с этим LUT.
  await stubDialogs(app, { open: [cubePath] });
  await page.getByRole('tab', { name: 'Образ' }).click();
  await page.getByRole('button', { name: 'Импорт LUT…' }).click();
  await expect(page.getByRole('combobox', { name: 'Образ' })).toContainText('Сепия');
  const lutRow = page.getByTestId('look-lut');
  await expect(lutRow).toContainText('сепия.cube');
  await expect(lutRow).toContainText('17³');
  await expect(lutRow).toHaveAttribute('data-state', 'ready');
  let project = await mainProject(page);
  const lutId = Object.keys(project?.luts ?? {})[0] ?? '';
  expect(project?.looks).toEqual([{ id: expect.any(String), name: 'Сепия', adjust: createAdjust(), importedLut: lutId }]);
  expect(project?.luts[lutId]).toMatchObject({ name: 'сепия.cube', size: 17 });
  expect(await readFile(join(projectDir, 'luts', `${lutId}.cube`), 'utf8')).toBe(await readFile(cubePath, 'utf8'));

  // 2. Образ на рампе и синей плитке: их цвет — core с этим LUT по тому же прокси; красная не меняется.
  const redBefore = await regionColor(tiles.nth(2), ...CENTER);
  await tiles.nth(0).click();
  await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('button', { name: 'Назначить выделенным' }).click();
  await expect(page.getByTestId('look-usage')).toHaveText('Применён к 2 плиткам');
  const withLut = bakePipeline({ photo: createAdjust(), look: createAdjust(), lut });
  for (const [k, region] of RAMP_REGIONS.entries()) {
    await expectTile(tiles.nth(0), region, regionThrough(proxies[0]!, through(withLut), ...region), 3, `рампа, область ${k + 1}`);
  }
  await expectTile(tiles.nth(1), CENTER, regionThrough(proxies[1]!, through(withLut), ...CENTER), 3, 'синяя');
  expect(maxDiff(await regionColor(tiles.nth(2), ...CENTER), redBefore), 'красная без образа не меняется').toBeLessThanOrEqual(1);

  // 3. Экспозиция образа +0.5: плитка — LUT(экспозиция(фото)), а не экспозиция(LUT(фото)): шаг 9 последний.
  await press(page, 'Экспозиция', 'ArrowRight', 10);
  await expect(page.getByTestId('value-exposure')).toHaveText('+0.50');
  const look: Adjust = { ...createAdjust(), exposure: 0.5 };
  const baked = bakePipeline({ photo: createAdjust(), look, lut });
  const lutThenExposure = (c: Rgb01) => applyPass(applyLutStep(c, lut), bakeAdjust(look));
  const lights = RAMP_REGIONS[2]!;
  const expected = regionThrough(proxies[0]!, through(baked), ...lights);
  const wrongOrder = regionThrough(proxies[0]!, lutThenExposure, ...lights);
  expect(maxDiff(expected, wrongOrder), 'тест не пустой: порядок шагов меняет цвет').toBeGreaterThan(8);
  await expectTile(tiles.nth(0), lights, expected, 3, 'рампа после экспозиции образа');
  for (const [k, region] of RAMP_REGIONS.entries()) {
    await expectTile(tiles.nth(0), region, regionThrough(proxies[0]!, through(baked), ...region), 3, `рампа, область ${k + 1}`);
  }
  const blueExpected = regionThrough(proxies[1]!, through(baked), ...CENTER);
  await expectTile(tiles.nth(1), CENTER, blueExpected, 3, 'синяя после экспозиции образа');

  // 4. Редактор фото показывает тот же цвет. Режим 5: заливка — доминанта core с LUT.
  await tiles.nth(1).click();
  await page.keyboard.press('KeyE');
  const canvas = page.getByTestId('editor-canvas');
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  await expect.poll(async () => maxDiff(await centerColor(page, canvas), blueExpected), { message: 'редактор: синяя' }).toBeLessThanOrEqual(3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('photo-editor')).toHaveCount(0);

  await page.keyboard.press('Digit5');
  const fill = tiles.nth(1).getByTestId('tile-fill');
  await expect(fill).toHaveAttribute('data-kind', 'dominant');
  const dominant = labToSrgb8(
    tileMetrics({ width: proxies[1]!.width, height: proxies[1]!.height, data: proxies[1]!.rgba }, createCrop(), '3:4', {
      photo: createAdjust(),
      look,
      lut,
    }).dominant,
  );
  const dominantOf = async () => {
    const { r, g, b } = await backgroundColor(fill);
    return deltaE2000(srgbToCielab([r / 255, g / 255, b / 255]), srgbToCielab(dominant.map((v) => v / 255) as Rgb01));
  };
  await expect.poll(dominantOf, { message: `доминанта синей, core rgb(${dominant.join(' ')})` }).toBeLessThan(1);
  await page.keyboard.press('Digit2');
  await expect(fill).toHaveCount(0);

  // 5. Экспорт «Сепии» в .cube 33 проходит проверку по кругу и, применённый тестом, даёт плитку.
  const screen: Color[] = [];
  for (const region of RAMP_REGIONS) screen.push(await regionColor(tiles.nth(0), ...region));
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const row = dialog.locator('[data-testid="lut-look"][data-name="Сепия"]');
  await expect(row.getByTestId('lut-check')).toHaveAttribute('data-state', 'pass');
  await expect(row.getByRole('radio', { name: '33' })).toBeChecked();
  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true');
  await expect(result).toContainText('Готово');
  const exported = join((await result.getAttribute('data-dir')) ?? '', 'Сепия.cube');
  expect(await readFile(exported, 'utf8')).toContain('\nLUT_3D_SIZE 33\n');
  const cube33 = await readCube(exported);
  expect(checkLut(cube33, through(bakePipeline(lookPipeline(look, lut)))).pass).toBe(true);
  for (const [k, region] of RAMP_REGIONS.entries()) {
    const viaFile = regionThrough(proxies[0]!, (c) => sampleLut(cube33, c), ...region);
    expect(maxDiff(viaFile, screen[k]!), `экспорт, область ${k + 1}: файл ${fmt(viaFile)}, экран ${fmt(screen[k]!)}`).toBeLessThanOrEqual(3);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // 6. «Снять LUT», затем удаление образа. ⌘Z возвращает образ, ещё одна ⌘Z — его LUT.
  await page.getByRole('button', { name: 'Снять LUT' }).click();
  await expect(lutRow).toHaveCount(0);
  await expect.poll(async () => (await mainProject(page))?.looks[0]?.importedLut).toBeUndefined();
  await expectTile(tiles.nth(1), CENTER, regionThrough(proxies[1]!, through(bakePipeline({ photo: createAdjust(), look })), ...CENTER), 3, 'без LUT');
  await page.getByRole('button', { name: 'Удалить' }).click();
  await expect.poll(async () => (await mainProject(page))?.looks.length).toBe(0);
  expect(Object.keys((await mainProject(page))?.luts ?? {})).toEqual([lutId]);

  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.looks.map((l) => [l.name, l.importedLut ?? null])).toEqual([['Сепия', null]]);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.looks[0]?.importedLut).toBe(lutId);
  project = await mainProject(page);
  expect(project?.slots.map((slot) => slot.lookId ?? null)).toEqual([project?.looks[0]?.id, project?.looks[0]?.id, null]);
  await expect(lutRow).toHaveAttribute('data-state', 'ready');
  await expectTile(tiles.nth(1), CENTER, blueExpected, 3, 'синяя после отмены');
  for (const [k, region] of RAMP_REGIONS.entries()) await expectTile(tiles.nth(0), region, screen[k]!, 1, `рампа после отмены, область ${k + 1}`);

  // 7. Исходный .cube удалён, папка проекта скопирована в другое место: в копии плитки те же.
  const before: Color[] = [];
  for (let t = 0; t < 3; t++) before.push(await regionColor(tiles.nth(t), ...CENTER));
  await app.close();
  app = undefined;
  await rm(cubePath);
  const movedDir = join(root, 'Перенесённый');
  await cp(projectDir, movedDir, { recursive: true });

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [movedDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, 3);
  const moved = page.getByTestId('tile');
  for (let t = 0; t < 3; t++) {
    await expectTile(moved.nth(t), CENTER, before[t]!, 2, `копия проекта, плитка ${t + 1}`);
  }
  await page.getByRole('tab', { name: 'Образ' }).click();
  await expect(page.getByTestId('look-lut')).toHaveAttribute('data-state', 'ready');

  // 8. Битые файлы — сообщение об ошибке, проект не меняется. Второй импортируется пунктом «Файл → Импортировать LUT…».
  const brokenDir = join(root, 'broken');
  await mkdir(brokenDir);
  const oneD = join(brokenDir, 'кривая.cube');
  await writeFile(oneD, 'TITLE "1D"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n');
  const rows = join(brokenDir, 'обрезан.cube');
  await writeFile(rows, 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n');
  const projectBefore = await mainProject(page);
  for (const [file, message, viaMenu] of [
    [oneD, '1D LUT не поддерживается', false],
    [rows, 'нужно 2³ = 8 строк данных, а их 3', true],
  ] as const) {
    await stubDialogs(app, { open: [file] });
    if (viaMenu) await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('importLut')?.click());
    else await page.getByRole('button', { name: 'Импорт LUT…' }).click();
    const error = page.getByTestId('lut-import-error');
    await expect(error).toContainText(message);
    await expect(error).toContainText(file.slice(brokenDir.length + 1));
    expect(await mainProject(page)).toEqual(projectBefore);
  }
});
