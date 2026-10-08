// Общее для e2e: запуск приложения, подмена системных диалогов, ожидание плиток.
import { join } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { RgbaImage } from '../../src/core/image/sample';
import type { Project } from '../../src/core/project/types';

export const ROOT = join(__dirname, '../..');

export async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd: ROOT });
  const page = await app.firstWindow();
  return { app, page };
}

/** Подменяет системные диалоги: тест не может кликать в окна macOS. */
export async function stubDialogs(app: ElectronApplication, answers: { save?: string; open?: string[] }): Promise<void> {
  await app.evaluate(({ dialog }, { save, open }) => {
    if (save !== undefined) dialog.showSaveDialog = (async () => ({ canceled: false, filePath: save })) as never;
    if (open !== undefined) dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: open })) as never;
  }, answers);
}

/**
 * Ждёт, пока холст нарисует фото во всех плитках (GridRenderer ставит data-rendered).
 * Холст рисует только видимые плитки, поэтому прокручиваем к каждой. Возвращает id ассетов по порядку.
 */
export async function expectTilesRendered(page: Page, count: number): Promise<string[]> {
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(count);
  for (const tile of await tiles.all()) {
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toHaveAttribute('data-rendered', 'true');
  }
  return tiles.evaluateAll((els) => els.map((el) => el.getAttribute('data-asset-id') ?? ''));
}

/** Средний цвет плитки на экране, 0..255. */
export async function tileColor(tile: Locator): Promise<{ r: number; g: number; b: number }> {
  return regionColor(tile, [0, 1], [0, 1]);
}

/** Холст перерисовывается в requestAnimationFrame: ждём два кадра. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const window = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
    const raf = (callback: () => void) => window.requestAnimationFrame(callback);
    return new Promise<void>((resolve) => raf(() => raf(resolve)));
  });
}

/** Снимок части плитки: x и y — доли её ширины и высоты. RGB 8 бит без альфы. */
export async function regionPixels(
  tile: Locator,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
): Promise<{ data: Buffer; width: number; height: number }> {
  await tile.scrollIntoViewIfNeeded();
  await nextFrames(tile.page());
  const box = await tile.boundingBox();
  if (!box) throw new Error('плитка не видна');
  const clip = { x: box.x + box.width * x0, y: box.y + box.height * y0, width: box.width * (x1 - x0), height: box.height * (y1 - y0) };
  const { data, info } = await sharp(await tile.page().screenshot({ clip }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Средний цвет части плитки на экране, 0..255. */
export async function regionColor(
  tile: Locator,
  x: [number, number],
  y: [number, number],
): Promise<{ r: number; g: number; b: number }> {
  const { data } = await regionPixels(tile, x, y);
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
  const n = data.length / 3;
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

/** Проект в main: renderer его не подменит, это то, что уйдёт на диск. */
export async function mainProject(page: Page): Promise<Project | undefined> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { gridtone: { invoke(channel: string): Promise<{ project: Project } | null> } })
      .gridtone;
    return (await api.invoke('project:get'))?.project;
  });
}

/** Двигает ползунок клавиатурой: Playwright не умеет fill у input type=range. */
export async function press(page: Page, slider: string, key: string, times: number): Promise<void> {
  await page.getByRole('slider', { name: slider }).focus();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

/** Цвет фона элемента после CSS, 0..255. */
export async function backgroundColor(locator: Locator): Promise<{ r: number; g: number; b: number }> {
  const css = await locator.evaluate((el) => {
    const window = globalThis as unknown as { getComputedStyle(element: unknown): { backgroundColor: string } };
    return window.getComputedStyle(el).backgroundColor;
  });
  const [r = NaN, g = NaN, b = NaN] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return { r, g, b };
}

/** Прокси 512 так, как его читает core (`RgbaImage`, RGBA 8 бит): по нему e2e сверяет метрики воркера с core. */
export async function readProxyImage(projectDir: string, assetId: string): Promise<RgbaImage> {
  const { data, info } = await sharp(join(projectDir, 'cache', 'proxies', assetId, '512.jpg'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
