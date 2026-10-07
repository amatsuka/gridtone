// Критерий этапа 2в: редактор открывается на прокси 2048; кадр ленты и окно сетки правятся мышью, и плитка
// в сетке показывает новое окно; повёрнутый кадр не выходит за фото; правки кадра отменяются и переживают перезапуск.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { Crop } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, regionColor, regionPixels, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterAll. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e2c-'));
});
test.afterAll(async () => {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** Высокое фото 2:5: кадр 4:5 и 3:4 в нём ходит по вертикали. */
const W = 1200;
const H = 3000;
/** Пять горизонтальных полос сверху вниз. */
const STRIPES: Rgb[] = [
  { r: 200, g: 40, b: 40 },
  { r: 220, g: 200, b: 40 },
  { r: 40, g: 160, b: 60 },
  { r: 40, g: 170, b: 200 },
  { r: 50, g: 60, b: 200 },
];
/**
 * Белая рамка по краю фото. За краем шейдер повторяет крайний пиксель (CLAMP_TO_EDGE), поэтому кадр,
 * вылезший за фото, дал бы в плитке белые клинья — это и есть «пиксели фона».
 */
const BORDER = 16;

function stripes(u: number, v: number): Rgb {
  const x = u * W;
  const y = v * H;
  if (x < BORDER || x > W - BORDER || y < BORDER || y > H - BORDER) return { r: 255, g: 255, b: 255 };
  return STRIPES[Math.min(STRIPES.length - 1, Math.floor(v * STRIPES.length))] as Rgb;
}

/** Номер полосы, ближайшей к цвету. */
function stripeOf(c: { r: number; g: number; b: number }): number {
  const d = STRIPES.map((s) => Math.hypot(s.r - c.r, s.g - c.g, s.b - c.b));
  return d.indexOf(Math.min(...d));
}

/** Доля почти белых точек плитки. Верх плитки пропускается: там белый номер. */
async function whiteShare(tile: Locator): Promise<number> {
  const { data } = await regionPixels(tile, [0.01, 0.99], [0.1, 0.99]);
  let white = 0;
  for (let i = 0; i < data.length; i += 3) if (Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 200) white++;
  return white / (data.length / 3);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('элемент не виден');
  return b;
}

async function dragMouse(page: Page, a: [number, number], b: [number, number]): Promise<void> {
  await page.mouse.move(...a);
  await page.mouse.down();
  await page.mouse.move(...b, { steps: 12 });
  await page.mouse.up();
}

const cropOf = async (page: Page, i: number): Promise<Crop | undefined> => (await mainProject(page))?.slots[i]?.crop;

test('кадр ленты и окно сетки правятся мышью, повёрнутый кадр не выходит за фото, кадр отменяется и переживает перезапуск', async () => {
  const photos = join(root, 'photos');
  const files = [
    await writePixelFixture(photos, '1-stripes', W, H, stripes),
    await writePixelFixture(photos, '2-gray', 900, 1200, () => ({ r: 120, g: 120, b: 120 })),
  ];
  const projectDir = join(root, 'Кадр');

  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${files.length}`);
  await expectTilesRendered(page, files.length);
  const tile = page.getByTestId('tile').nth(0);
  const top = async () => stripeOf(await regionColor(tile, [0.2, 0.8], [0.04, 0.12]));
  const bottom = async () => stripeOf(await regionColor(tile, [0.2, 0.8], [0.88, 0.95]));
  // Кадр по умолчанию — 3:4 по центру: в плитке полосы со второй по четвёртую.
  expect([await top(), await bottom()]).toEqual([1, 3]);

  // 1. E открывает редактор на прокси 2048: длинная сторона текстуры — 2048.
  await tile.click();
  await page.keyboard.press('KeyE');
  const editor = page.getByTestId('photo-editor');
  await expect(editor).toBeVisible();
  const canvas = page.getByTestId('editor-canvas');
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  await expect(canvas).toHaveAttribute('data-texture', /^\d+x2048$/);

  // 2. Кадр ленты 4:5; окно сетки, сдвинутое мышью вниз, упирается в край кадра и тянет его до низа фото.
  await page.getByRole('tab', { name: 'Кадр' }).click();
  await page.getByRole('button', { name: '4:5' }).click();
  await expect.poll(async () => (await cropOf(page, 0))?.feed.aspect).toBe('4:5');
  const photo = await box(page.getByTestId('crop-overlay'));
  const win = await box(page.getByTestId('crop-grid'));
  const center: [number, number] = [win.x + win.width / 2, win.y + win.height / 2];
  await dragMouse(page, center, [center[0], center[1] + photo.height * 0.35]);
  await expect.poll(async () => (await cropOf(page, 0))?.feed.cy).toBeCloseTo(0.75, 4);
  expect((await cropOf(page, 0))?.grid).toEqual({ cx: 0.5, cy: 0.5 });

  // Масштаб за угол кадра: левый верхний угол к центру кадра — кадр меньше. Весь жест — одна запись истории.
  const handle = await box(page.getByTestId('crop-handle').first());
  const corner: [number, number] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  const frameCenter: [number, number] = [photo.x + photo.width / 2, photo.y + photo.height * 0.75];
  await dragMouse(page, corner, [corner[0] + (frameCenter[0] - corner[0]) * 0.3, corner[1] + (frameCenter[1] - corner[1]) * 0.3]);
  await expect.poll(async () => (await cropOf(page, 0))?.feed.zoom).toBeGreaterThan(1.3);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await cropOf(page, 0))?.feed.zoom).toBe(1);

  // Esc закрывает редактор; плитка в сетке показывает новое окно: внизу — нижняя полоса.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect.poll(bottom).toBe(4);
  expect(await top()).toBe(2);

  // 3. Поворот 15°: кадр уменьшается и остаётся внутри фото — в плитке нет белых клиньев рамки.
  await page.keyboard.press('KeyE');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Кадр' })).toHaveAttribute('aria-selected', 'true');
  const angle = page.getByRole('spinbutton', { name: 'Угол поворота' });
  await angle.fill('15');
  await angle.press('Enter');
  await expect.poll(async () => (await cropOf(page, 0))?.feed.angle).toBe(15);
  await expect(page.getByTestId('value-angle')).toHaveText('+15.0°');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  // Второй Esc снимает выделение: рамка выделения тоже светлая.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="tile"][aria-selected="true"]')).toHaveCount(0);
  const rotatedCrop = await cropOf(page, 0);
  await expect.poll(() => whiteShare(tile)).toBeLessThan(0.005);
  const rotated = { top: await regionColor(tile, [0.2, 0.8], [0.04, 0.12]), bottom: await regionColor(tile, [0.2, 0.8], [0.88, 0.95]) };

  // 4. → переходит к следующему посту, Esc закрывает, ⌘Z возвращает кадр.
  await tile.click();
  await page.keyboard.press('KeyE');
  await expect(editor).toHaveAttribute('data-slot-id', (await mainProject(page))?.slots[0]?.id ?? '');
  await page.keyboard.press('ArrowRight');
  await expect(editor).toHaveAttribute('data-slot-id', (await mainProject(page))?.slots[1]?.id ?? '');
  await expect(page.getByTestId('editor-position')).toHaveText('Пост 2 из 2');
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  expect(Number(await canvas.getAttribute('data-textures'))).toBeLessThanOrEqual(3);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(async () => (await cropOf(page, 0))?.feed.angle).toBe(0);
  expect((await cropOf(page, 0))?.feed).toEqual({ aspect: '4:5', cx: 0.5, cy: 0.75, zoom: 1, angle: 0 });
  await expect.poll(bottom).toBe(4);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(() => cropOf(page, 0)).toEqual(rotatedCrop);

  // 5. Выход без ожидания автосохранения: после перезапуска кадр на месте.
  await app.close();
  app = undefined;
  const saved = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as { slots: { crop: Crop }[] };
  expect(saved.slots[0]?.crop).toEqual(rotatedCrop);

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, files.length);
  const reopened = page.getByTestId('tile').nth(0);
  expect(await whiteShare(reopened)).toBeLessThan(0.005);
  const after = { top: await regionColor(reopened, [0.2, 0.8], [0.04, 0.12]), bottom: await regionColor(reopened, [0.2, 0.8], [0.88, 0.95]) };
  for (const part of ['top', 'bottom'] as const) {
    for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(after[part][c] - rotated[part][c]), `${part}.${c}`).toBeLessThan(2);
  }
  await reopened.dblclick();
  await expect(page.getByTestId('photo-editor')).toBeVisible();
  await page.getByRole('tab', { name: 'Кадр' }).click();
  await expect(page.getByTestId('value-angle')).toHaveText('+15.0°');
  await expect(page.getByRole('button', { name: '4:5' })).toHaveAttribute('aria-pressed', 'true');
  await app.close();
  app = undefined;
});
