// Критерий этапа 0: 30 фото импортируются, проект закрывается и открывается без потерь.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateImportSet } from '../fixtures/generate';

const COUNT = 30;
let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e-'));
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '../..') });
  const page = await app.firstWindow();
  return { app, page };
}

/** Подменяет системные диалоги: тест не может кликать в окна macOS. */
async function stubDialogs(app: ElectronApplication, answers: { save?: string; open?: string[] }): Promise<void> {
  await app.evaluate(({ dialog }, { save, open }) => {
    if (save !== undefined) dialog.showSaveDialog = (async () => ({ canceled: false, filePath: save })) as never;
    if (open !== undefined) dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: open })) as never;
  }, answers);
}

/** Ждёт, пока все плитки покажут прокси. Плитки грузятся лениво, поэтому прокручиваем к каждой. */
async function expectTilesLoaded(page: Page, count: number): Promise<string[]> {
  const tiles = page.getByTestId('tile');
  await expect(tiles).toHaveCount(count);
  for (const tile of await tiles.all()) {
    await tile.scrollIntoViewIfNeeded();
    const img = tile.locator('img');
    await expect
      .poll(() => img.evaluate((el: { complete: boolean; naturalWidth: number }) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  }
  return tiles.evaluateAll((els) => els.map((el) => el.getAttribute('data-asset-id') ?? ''));
}

test('30 фото импортируются, проект закрывается и открывается без потерь', async () => {
  const photos = await generateImportSet(join(root, 'photos'), COUNT);
  const projectDir = join(root, 'Весенняя сетка');

  // Сессия 1: создать проект, импортировать фото и сразу выйти — автосохранение должно успеть.
  let { app, page } = await launch();
  await stubDialogs(app, { save: projectDir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await expect(page.getByTestId('project-name')).toHaveText('Весенняя сетка');

  await page.getByRole('button', { name: 'Импорт фото' }).click();
  const status = page.getByTestId('import-status');
  await expect(status).toContainText(`Импорт завершён: добавлено ${COUNT}`);
  await expect(status).not.toContainText('ошибок');
  await expect(status).not.toContainText('уже в проекте');
  const order = await expectTilesLoaded(page, COUNT);
  await app.close();

  const savedJson = await readFile(join(projectDir, 'project.json'), 'utf8');
  const saved = JSON.parse(savedJson) as {
    slots: { assetId: string }[];
    assets: Record<string, { path: string }>;
  };
  expect(saved.slots.map((slot) => slot.assetId)).toEqual(order);
  // Порядок в сетке совпадает с порядком файлов photo-01 … photo-30.
  expect(saved.slots.map((slot) => basename(saved.assets[slot.assetId]?.path ?? ''))).toEqual(
    photos.map((path) => basename(path)),
  );

  // Сессия 2: открыть проект — те же плитки в том же порядке, project.json не изменился.
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expect(page.getByTestId('project-name')).toHaveText('Весенняя сетка');
  expect(await expectTilesLoaded(page, COUNT)).toEqual(order);
  await expect(page.getByTestId('save-state')).toHaveText('Сохранено');
  await app.close();

  expect(await readFile(join(projectDir, 'project.json'), 'utf8')).toBe(savedJson);
});
