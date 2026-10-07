// Критерий этапа 0: 30 фото импортируются, проект закрывается и открывается без потерь.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { generateImportSet } from '../fixtures/generate';
import { expectTilesRendered, launch, stubDialogs } from './helpers';

const COUNT = 30;
let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e-'));
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

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
  const order = await expectTilesRendered(page, COUNT);
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
  expect(await expectTilesRendered(page, COUNT)).toEqual(order);
  await expect(page.getByTestId('save-state')).toHaveText('Сохранено');
  await app.close();

  expect(await readFile(join(projectDir, 'project.json'), 'utf8')).toBe(savedJson);
});
