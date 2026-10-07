// Общее для e2e: запуск приложения, подмена системных диалогов, ожидание плиток.
import { join } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
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
  // Холст перерисовывается в requestAnimationFrame после прокрутки к плитке.
  await tile.scrollIntoViewIfNeeded();
  await tile.page().evaluate(() => {
    const window = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
    const raf = (callback: () => void) => window.requestAnimationFrame(callback);
    return new Promise<void>((resolve) => raf(() => raf(resolve)));
  });
  const { channels } = await sharp(await tile.screenshot()).stats();
  const [r, g, b] = channels.map((c) => c.mean);
  return { r: r ?? NaN, g: g ?? NaN, b: b ?? NaN };
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
