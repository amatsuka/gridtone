// Критерий этапа 2б: кривые, HSL и круги правятся мышью и меняют плитку в реальном времени;
// клавиши 1–7 переключают режимы; режимы 3 и 4 совпадают с эталоном в core (сверка шейдера —
// в shader-parity.spec.ts); удержание `\` показывает фото до правок.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { deltaE2000, srgbToCielab } from '../../src/core/color/deltaE';
import { oklabToLinearSrgb, oklchToOklab } from '../../src/core/color/oklab';
import type { Rgb as Rgb01 } from '../../src/core/color/srgb';
import { wheelToPoint } from '../../src/core/color/swatches';
import { encodeSrgbClamped } from '../../src/core/color/transfer';
import { applyView, oklabL } from '../../src/core/color/view';
import { labToSrgb8, tileMetrics } from '../../src/core/metrics/tile';
import { createAdjust, createCrop } from '../../src/core/project/defaults';
import type { Project } from '../../src/core/project/types';
import { VIEW_MODES } from '../../shared/view';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { backgroundColor, expectTilesRendered, launch, mainProject, press, regionColor, regionPixels, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e2b-'));
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

/** OKLCH → sRGB 0..255 со срезом в охват. */
function oklch(L: number, C: number, h: number): Rgb {
  const [r, g, b] = encodeSrgbClamped(oklabToLinearSrgb(oklchToOklab([L, C, h])));
  return { r: r * 255, g: g * 255, b: b * 255 };
}

const solid = (color: Rgb) => () => color;
/** Серая рампа слева направо: от чёрного к белому. */
const ramp = (u: number): Rgb => ({ r: u * 255, g: u * 255, b: u * 255 });

/** Новый проект в папке dir с фото по порядку. Возвращает id ассетов в порядке сетки. */
async function createProject(dir: string, photos: string[]): Promise<{ page: Page; ids: string[] }> {
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: dir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${photos.length}`);
  return { page, ids: await expectTilesRendered(page, photos.length) };
}

/** Перетаскивание мышью от точки a к точке b в координатах экрана. */
async function dragMouse(page: Page, a: [number, number], b: [number, number]): Promise<void> {
  await page.mouse.move(...a);
  await page.mouse.down();
  await page.mouse.move(...b, { steps: 10 });
  await page.mouse.up();
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error('элемент не виден');
  return b;
}

const blueMinusRed = (c: { r: number; b: number }) => c.b - c.r;
const grayness = (c: { r: number; g: number; b: number }) => Math.max(Math.abs(c.r - c.g), Math.abs(c.g - c.b), Math.abs(c.r - c.b));

test('кривые, HSL и круги правятся мышью и сразу меняют плитку; `\\` показывает исходник', async () => {
  const photos = join(root, 'tools');
  const blue = oklch(0.55, 0.15, 264);
  const red = oklch(0.6, 0.18, 29);
  const files = [
    await writePixelFixture(photos, '1-ramp', W, H, ramp),
    await writePixelFixture(photos, '2-blue', W, H, solid(blue)),
    await writePixelFixture(photos, '3-red', W, H, solid(red)),
  ];
  const { page } = await createProject(join(root, 'Инструменты'), files);
  const tiles = page.getByTestId('tile');
  const rampTile = tiles.nth(0);
  const middle = (): Promise<{ r: number; g: number; b: number }> => regionColor(rampTile, [0.45, 0.55], [0.3, 0.7]);
  const shadows = () => regionColor(rampTile, [0.04, 0.2], [0.3, 0.7]);
  const lights = () => regionColor(rampTile, [0.85, 0.97], [0.3, 0.7]);

  // Кривая: точка общей кривой, поднятая мышью из (0.5, 0.5) в (0.5, 0.75), осветляет средние тона.
  await rampTile.click();
  const before = await middle();
  const graph = page.getByTestId('curve-editor');
  const g = await box(graph);
  await dragMouse(page, [g.x + g.width * 0.5, g.y + g.height * 0.5], [g.x + g.width * 0.5, g.y + g.height * 0.25]);
  await expect.poll(async () => (await middle()).g, { timeout: 1000 }).toBeGreaterThan(before.g + 25);
  const curve = (await mainProject(page))?.slots[0]?.adjust.curves.master ?? [];
  expect(curve).toHaveLength(3);
  expect(curve[1]?.[0]).toBeCloseTo(0.5, 1);
  expect(curve[1]?.[1]).toBeCloseTo(0.75, 1);
  // Весь жест — одна запись истории: одна отмена возвращает прямую.
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await mainProject(page))?.slots[0]?.adjust.curves.master).toEqual(createAdjust().curves.master);
  await expect.poll(async () => Math.abs((await middle()).g - before.g)).toBeLessThan(1);
  // Точка, уведённая за край графика, удаляется. Влево: график бывает у нижнего края окна,
  // а движения мыши за пределами окна до страницы не доходят.
  const g2 = await box(graph);
  await dragMouse(page, [g2.x + g2.width * 0.5, g2.y + g2.height * 0.5], [g2.x - 60, g2.y + g2.height * 0.5]);
  await expect.poll(async () => (await mainProject(page))?.slots[0]?.adjust.curves.master).toEqual(createAdjust().curves.master);

  // Круг теней к синему (тон 264°, сила 80) окрашивает тени рампы, света — нет.
  const neutralShadows = await shadows();
  expect(Math.abs(blueMinusRed(neutralShadows))).toBeLessThan(3);
  const wheel = await box(page.getByTestId('wheel-shadows'));
  const center: [number, number] = [wheel.x + wheel.width / 2, wheel.y + wheel.height / 2];
  const [dx, dy] = wheelToPoint(264, 80);
  await dragMouse(page, [center[0] + 4, center[1] + 4], [center[0] + (dx * wheel.width) / 2, center[1] + (dy * wheel.height) / 2]);
  await expect.poll(async () => blueMinusRed(await shadows()), { timeout: 1000 }).toBeGreaterThan(10);
  expect(Math.abs(blueMinusRed(await lights()))).toBeLessThan(3);
  const grading = (await mainProject(page))?.slots[0]?.adjust.grading.shadows;
  expect(Math.abs((grading?.hue ?? 0) - 264)).toBeLessThanOrEqual(2);
  expect(Math.abs((grading?.amount ?? 0) - 80)).toBeLessThanOrEqual(2);

  // Удержание `\` — исходник без правок; отпускание — снова с правками.
  await page.keyboard.down('Backslash');
  await expect(page.getByTestId('original-badge')).toBeVisible();
  await expect.poll(async () => Math.abs(blueMinusRed(await shadows()))).toBeLessThan(3);
  await page.keyboard.up('Backslash');
  await expect(page.getByTestId('original-badge')).toHaveCount(0);
  await expect.poll(async () => blueMinusRed(await shadows())).toBeGreaterThan(10);

  // С Shift круг меняет только силу: тон остаётся 264°, хотя мышь ушла к 0°.
  const [sx] = wheelToPoint(0, 40);
  await page.keyboard.down('Shift');
  await dragMouse(page, [center[0] + 2, center[1]], [center[0] + (sx * wheel.width) / 2, center[1]]);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await mainProject(page))?.slots[0]?.adjust.grading.shadows).toEqual({ hue: 264, amount: 40 });

  // HSL: насыщенность синих −100 в образе синей и красной плиток — синяя серая, красная не меняется.
  const blueBefore = await regionColor(tiles.nth(1), [0.3, 0.7], [0.3, 0.7]);
  const redBefore = await regionColor(tiles.nth(2), [0.3, 0.7], [0.3, 0.7]);
  expect(grayness(blueBefore)).toBeGreaterThan(60);
  await tiles.nth(1).click();
  await tiles.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('tab', { name: 'Образ' }).click();
  await page.getByRole('button', { name: 'Новый образ' }).click();
  await page.getByRole('button', { name: 'Назначить выделенным' }).click();
  await page.getByTestId('hsl-panel').getByRole('tab', { name: 'Насыщенность' }).click();
  await press(page, 'Синий', 'Home', 1);
  await expect(page.getByTestId('value-hsl-blue-sat')).toHaveText('−100');
  await expect.poll(async () => grayness(await regionColor(tiles.nth(1), [0.3, 0.7], [0.3, 0.7])), { timeout: 1000 }).toBeLessThan(4);
  const redAfter = await regionColor(tiles.nth(2), [0.3, 0.7], [0.3, 0.7]);
  for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(redAfter[c] - redBefore[c])).toBeLessThan(1);
  await expect
    .poll(async () => (await mainProject(page))?.looks[0]?.adjust.hsl.blue)
    .toEqual({ hue: 0, sat: -100, lum: 0 });
});

/** Серые уровни на снимке: значения, которые занимают хотя бы 0.5% точек, с допуском ±2. */
function grayLevels(data: Buffer): { levels: number[]; maxSpread: number } {
  const counts = new Map<number, number>();
  let maxSpread = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
    maxSpread = Math.max(maxSpread, Math.abs(r - g), Math.abs(g - b));
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const total = data.length / 3;
  const levels: number[] = [];
  for (const [value] of [...counts].filter(([, n]) => n > total * 0.005).sort((a, b) => a[0] - b[0])) {
    if (levels.length === 0 || value - (levels.at(-1) as number) > 2) levels.push(value);
  }
  return { levels, maxSpread };
}

/** Наибольший скачок между соседними точками по горизонтали — мера резкости. */
function maxStep(data: Buffer, width: number, height: number): number {
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 3;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(data[i + c]! - data[i - 3 + c]!);
      max = Math.max(max, d);
    }
  }
  return max;
}

/** Пиксели прокси 512 так, как их читает core: RGBA 8 бит. */
async function readProxy(projectDir: string, assetId: string) {
  const { data, info } = await sharp(join(projectDir, 'cache', 'proxies', assetId, '512.jpg'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

test('клавиши 1–7 переключают режимы; яркость, постеризация, доминанты, прищур и профиль', async () => {
  const photos = join(root, 'views');
  const orange: Rgb = { r: 200, g: 120, b: 40 };
  const files = [
    await writePixelFixture(photos, '1-ramp', W, H, ramp),
    await writePixelFixture(photos, '2-orange', W, H, solid(orange)),
    // Сверху 65% бирюзового, снизу светлый беж.
    await writePixelFixture(photos, '3-two-tone', W, H, (_, v) => (v < 0.65 ? { r: 30, g: 140, b: 150 } : { r: 225, g: 205, b: 180 })),
    await writePixelFixture(photos, '4-dark', W, H, solid({ r: 40, g: 40, b: 60 })),
    await writePixelFixture(photos, '5-light', W, H, solid({ r: 230, g: 225, b: 210 })),
  ];
  const projectDir = join(root, 'Режимы');
  const { page, ids } = await createProject(projectDir, files);
  const tiles = page.getByTestId('tile');
  const mode = page.getByTestId('view-mode');

  // Клавиши 1–7 по порядку.
  for (const [i, name] of VIEW_MODES.entries()) {
    await page.keyboard.press(`Digit${i + 1}`);
    await expect(mode).toHaveAttribute('data-mode', name);
  }
  // Переключатель в тулбаре и пункт меню «Вид».
  await page.getByRole('button', { name: 'Постеризация' }).click();
  await expect(mode).toHaveAttribute('data-mode', 'posterize');
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('view:dominant')?.click());
  await expect(mode).toHaveAttribute('data-mode', 'dominant');

  // В поле ввода цифры — просто текст.
  await page.getByRole('tab', { name: 'Образ' }).click();
  await page.getByRole('button', { name: 'Новый образ' }).click();
  const name = page.getByRole('textbox', { name: 'Имя образа' });
  await name.focus();
  await page.keyboard.press('Digit3');
  await expect(name).toHaveValue(/3/);
  await expect(mode).toHaveAttribute('data-mode', 'dominant');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Фото' }).click();

  // 3 — яркость: плитка серая и совпадает с core по тому же прокси.
  await page.keyboard.press('Digit3');
  const orangeProxy = await readProxy(projectDir, ids[1]!);
  const center = orangeProxy.data.subarray(((orangeProxy.height >> 1) * orangeProxy.width + (orangeProxy.width >> 1)) * 4);
  const expectedGray = applyView([center[0]! / 255, center[1]! / 255, center[2]! / 255], 'luminance')[0] * 255;
  await expect.poll(async () => grayness(await regionColor(tiles.nth(1), [0.3, 0.7], [0.3, 0.7]))).toBeLessThan(2);
  const gray = await regionColor(tiles.nth(1), [0.3, 0.7], [0.3, 0.7]);
  expect(Math.abs(gray.g - expectedGray), `серый ${gray.g.toFixed(1)}, core ${expectedGray.toFixed(1)}`).toBeLessThan(3);

  // 4 — постеризация: на рампе не больше 5 уровней серого.
  await page.keyboard.press('Digit4');
  await expect
    .poll(async () => {
      const { levels, maxSpread } = grayLevels((await regionPixels(tiles.nth(0), [0.02, 0.98], [0.3, 0.7])).data);
      return { count: levels.length, maxSpread };
    })
    .toEqual({ count: 5, maxSpread: 0 });

  // 5 — доминанты: заливка совпадает с доминантой core по тому же прокси, ΔE2000 < 1.
  // Рампа заливается тоже, но её главный цвет — один из пяти почти равных по доле отрезков: от различий
  // декодеров JPEG на ±1 он может смениться, поэтому с core сверяются только плитки с явным главным цветом.
  await page.keyboard.press('Digit5');
  const fills = page.getByTestId('tile-fill');
  await expect(fills).toHaveCount(files.length);
  for (const [i, assetId] of ids.entries()) {
    if (i === 0) continue;
    const expected = labToSrgb8(tileMetrics(await readProxy(projectDir, assetId), createCrop(), '3:4', { photo: createAdjust() }).dominant);
    const fill = tiles.nth(i).getByTestId('tile-fill');
    await expect(fill).toHaveAttribute('data-kind', 'dominant');
    const { r, g, b } = await backgroundColor(fill);
    const d = deltaE2000(srgbToCielab([r / 255, g / 255, b / 255]), srgbToCielab(expected.map((v) => v / 255) as Rgb01));
    expect(d, `плитка ${i + 1}: rgb(${r} ${g} ${b}), core rgb(${expected.join(' ')})`).toBeLessThan(1);
  }

  // 6 — прищур: холст размыт, номера скрыты.
  const firstRow = async () => {
    const a = await box(tiles.nth(0));
    const c = await box(tiles.nth(2));
    const clip = { x: a.x + 10, y: a.y + a.height * 0.5, width: c.x + c.width - a.x - 20, height: 4 };
    const { data, info } = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return maxStep(data, info.width, info.height);
  };
  await page.keyboard.press('Digit2');
  await expect(tiles.nth(0).getByTestId('tile-fill')).toHaveCount(0);
  const sharpStep = await firstRow();
  expect(sharpStep).toBeGreaterThan(100);
  await page.keyboard.press('Digit6');
  await expect(page.locator('.grid-canvas')).toHaveCSS('filter', /blur\(\d/);
  await expect.poll(firstRow).toBeLessThan(15);
  await expect(tiles.nth(0).locator('.tile-number')).toHaveCSS('opacity', '0');

  // 1 — профиль: колонка 390 pt, шапка, промежутки 2 px, номеров нет.
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('profile-header')).toBeVisible();
  await expect.poll(async () => (await box(page.getByTestId('grid'))).width).toBeCloseTo(390, 0);
  await expect(tiles.nth(0).locator('.tile-number')).toBeHidden();
  const [t0, t1] = [await box(tiles.nth(0)), await box(tiles.nth(1))];
  expect(t1.x - (t0.x + t0.width)).toBeCloseTo(2, 0);

  // 2 — снова рабочая сетка.
  await page.keyboard.press('Digit2');
  await expect(page.getByTestId('profile-header')).toHaveCount(0);
  await expect(tiles.nth(0).locator('.tile-number')).toBeVisible();
});

test('режим 7: плитка в цели зелёная, далёкая красная, без цели серая', async () => {
  const photos = join(root, 'targets');
  const colors: Rgb[] = [
    { r: 150, g: 150, b: 150 },
    { r: 90, g: 110, b: 160 },
    { r: 200, g: 170, b: 120 },
  ];
  const files = [];
  for (const [i, color] of colors.entries()) files.push(await writePixelFixture(photos, `${i + 1}`, W, H, solid(color)));
  const projectDir = join(root, 'Цели');
  await createProject(projectDir, files);
  await app!.close();
  app = undefined;

  // Цели в фикстуре: интерфейса целей ещё нет, они появятся на этапах 4–5.
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  const L = (c: Rgb) => oklabL([c.r / 255, c.g / 255, c.b / 255]);
  const tolerance = { L: 0.05, hue: 20, chroma: 0.04 };
  project.slots[0]!.target = { L: L(colors[0]!), tolerance, hard: true };
  project.slots[1]!.target = { L: Math.min(1, L(colors[1]!) + 0.3), tolerance, hard: true };
  await writeFile(file, JSON.stringify(project, null, 2));

  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, colors.length);
  await page.keyboard.press('Digit7');

  const fill = (i: number) => page.getByTestId('tile').nth(i).getByTestId('tile-fill');
  const rgb = (i: number) => backgroundColor(fill(i));

  await expect(fill(0)).toHaveAttribute('data-kind', 'deviation');
  expect(Number(await fill(0).getAttribute('data-value'))).toBeLessThan(0.5);
  const inTarget = await rgb(0);
  expect(inTarget.g - inTarget.r, 'в цели — зелёная').toBeGreaterThan(40);

  await expect(fill(1)).toHaveAttribute('data-kind', 'deviation');
  expect(Number(await fill(1).getAttribute('data-value'))).toBeGreaterThan(2);
  const far = await rgb(1);
  expect(far.r - far.g, 'далёкая — красная').toBeGreaterThan(60);
  await expect(fill(1)).toHaveText(/^\d+(\.\d)?$/);

  await expect(fill(2)).toHaveAttribute('data-kind', 'no-target');
  await expect(fill(2)).toHaveText('нет цели');
  expect(grayness(await rgb(2))).toBe(0);
});
