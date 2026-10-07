// Критерий этапа 2а: перестановка, образы и копирование правок отменяются и возвращаются;
// всё переживает перезапуск.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { Project } from '../../src/core/project/types';
import { writeFixture } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, press, stubDialogs, tileColor } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterAll. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e2a-'));
});
test.afterAll(async () => {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const COLORS = [
  { r: 150, g: 120, b: 100 },
  { r: 90, g: 130, b: 160 },
  { r: 120, g: 150, b: 90 },
  { r: 170, g: 110, b: 140 },
  { r: 110, g: 110, b: 110 },
  { r: 160, g: 150, b: 90 },
  { r: 100, g: 140, b: 140 },
  { r: 140, g: 100, b: 90 },
  { r: 120, g: 120, b: 150 },
];

/** Порядок ассетов в сетке на экране. */
function screenOrder(page: Page): Promise<string[]> {
  return page.getByTestId('tile').evaluateAll((els) => els.map((el) => el.getAttribute('data-asset-id') ?? ''));
}

const assetOrder = (project: Project | undefined) => project?.slots.map((slot) => slot.assetId) ?? [];

/** Тянет плитку мышью с позиции from на позицию to. Обе плитки должны поместиться на экране. */
async function dragTile(page: Page, from: number, to: number): Promise<void> {
  const tiles = page.getByTestId('tile');
  // expectTilesRendered оставляет сетку прокрученной к последней плитке.
  await tiles.nth(from).scrollIntoViewIfNeeded();
  await tiles.nth(to).scrollIntoViewIfNeeded();
  const a = await tiles.nth(from).boundingBox();
  const b = await tiles.nth(to).boundingBox();
  if (!a || !b) throw new Error('плитка не видна');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('перестановка, образы и копирование правок отменяются, повторяются и переживают перезапуск', async () => {
  const photos: string[] = [];
  for (const [i, color] of COLORS.entries()) {
    photos.push(await writeFixture(join(root, 'photos'), { name: `photo-${i + 1}`, width: 900, height: 1200, format: 'jpeg', color }));
  }
  const projectDir = join(root, 'Сетка');

  // 1. Импорт 9 фото.
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${COLORS.length}`);
  const ids = await expectTilesRendered(page, COLORS.length);
  const imported = await mainProject(page);
  expect(assetOrder(imported)).toEqual(ids);

  // 2. Плитка 1 перетаскивается на место 5, Shift+→ сдвигает её ещё на позицию.
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = ids;
  await dragTile(page, 0, 4);
  await expect.poll(() => screenOrder(page)).toEqual([a1, a2, a3, a4, a0, a5, a6, a7, a8]);
  await page.keyboard.press('Shift+ArrowRight');
  const moved = [a1, a2, a3, a4, a5, a0, a6, a7, a8];
  await expect.poll(() => screenOrder(page)).toEqual(moved);
  await expect.poll(async () => assetOrder(await mainProject(page))).toEqual(moved);

  // 3. Новый образ назначается трём плиткам, его экспозиция +1 осветляет только их.
  const tiles = page.getByTestId('tile');
  const lookTiles = [0, 2, 6];
  await tiles.nth(0).click();
  await tiles.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await tiles.nth(6).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-testid="tile"][aria-selected="true"]')).toHaveCount(3);
  const before = [];
  for (let i = 0; i < COLORS.length; i++) before.push(await tileColor(tiles.nth(i)));

  await page.getByRole('tab', { name: 'Образ' }).click();
  await page.getByRole('button', { name: 'Новый образ' }).click();
  await page.getByRole('button', { name: 'Назначить выделенным' }).click();
  await expect(page.getByTestId('look-usage')).toHaveText('Применён к 3 плиткам');
  await press(page, 'Экспозиция', 'ArrowRight', 20);
  await expect(page.getByTestId('value-exposure')).toHaveText('+1.00');
  for (const i of lookTiles) {
    await expect.poll(async () => (await tileColor(tiles.nth(i))).g).toBeGreaterThan((before[i]?.g ?? 0) + 30);
  }
  for (let i = 0; i < COLORS.length; i++) {
    if (lookTiles.includes(i)) continue;
    const after = await tileColor(tiles.nth(i));
    for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(after[c] - (before[i]?.[c] ?? 0)), `плитка ${i + 1}`).toBeLessThan(1);
  }

  // 4. ⌘⇧C на плитке A, ⌘⇧V на двух других: их коррекция равна коррекции A.
  await tiles.nth(1).click();
  await page.getByRole('tab', { name: 'Фото' }).click();
  await press(page, 'Температура', 'ArrowLeft', 30);
  await press(page, 'Контраст', 'ArrowRight', 20);
  await expect(page.getByTestId('value-contrast')).toHaveText('+20');
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Копировать' }).click();
  await expect(dialog).toHaveCount(0);
  await tiles.nth(3).click();
  await tiles.nth(4).click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('ControlOrMeta+Shift+KeyV');
  await expect
    .poll(async () => {
      const slots = (await mainProject(page))?.slots ?? [];
      return [slots[3]?.adjust, slots[4]?.adjust];
    })
    .toEqual([expect.objectContaining({ temp: -30, contrast: 20 }), expect.objectContaining({ temp: -30, contrast: 20 })]);
  const final = await mainProject(page);
  expect(final?.slots[3]?.adjust).toEqual(final?.slots[1]?.adjust);
  expect(final?.slots[4]?.adjust).toEqual(final?.slots[1]?.adjust);
  expect(final?.looks).toHaveLength(1);
  const lookId = final?.looks[0]?.id;
  expect(final?.slots.filter((slot) => slot.lookId === lookId)).toHaveLength(3);

  // 5. ⌘Z до конца истории — проект как сразу после импорта; ⌘⇧Z до конца — итоговое состояние.
  // В истории 75 действий: каждое нажатие стрелки на ползунке — своя запись. Лишние нажатия ничего не меняют.
  for (let i = 0; i < 100; i++) await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(() => mainProject(page)).toEqual(imported);
  await expect.poll(() => screenOrder(page)).toEqual(ids);

  for (let i = 0; i < 100; i++) await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(() => mainProject(page)).toEqual(final);
  await expect.poll(() => screenOrder(page)).toEqual(moved);

  // 6. Выход без ожидания автосохранения и повторное открытие.
  await app.close();
  app = undefined;
  const saved = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as Project;
  expect(saved.slots).toEqual(final?.slots);
  expect(saved.looks).toEqual(final?.looks);

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  expect(await expectTilesRendered(page, COLORS.length)).toEqual(moved);
  await page.getByTestId('tile').nth(6).click();
  await page.getByRole('tab', { name: 'Образ' }).click();
  await expect(page.getByTestId('look-usage')).toHaveText('Применён к 3 плиткам');
  await expect(page.getByTestId('value-exposure')).toHaveText('+1.00');
  await page.getByRole('tab', { name: 'Фото' }).click();
  await page.getByTestId('tile').nth(4).click();
  await expect(page.getByTestId('value-temp')).toHaveText('−30');
  await expect(page.getByTestId('value-contrast')).toHaveText('+20');
  await app.close();
  app = undefined;
});
