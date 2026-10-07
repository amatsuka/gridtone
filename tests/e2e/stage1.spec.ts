// Критерий этапа 1 (кроме совпадения шейдера — оно в shader-parity.spec.ts):
// ползунок меняет плитку в реальном времени, правки переживают перезапуск.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createAdjust } from '../../src/core/project/defaults';
import type { Project } from '../../src/core/project/types';
import { writeFixture } from '../fixtures/generate';
import { expectTilesRendered, launch, mainProject, press, stubDialogs, tileColor } from './helpers';

let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e1-'));
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const COLORS = [
  { r: 150, g: 120, b: 100 },
  { r: 90, g: 130, b: 160 },
  { r: 120, g: 150, b: 90 },
  { r: 170, g: 110, b: 140 },
  { r: 110, g: 110, b: 110 },
  { r: 160, g: 150, b: 90 },
];

test('ползунок сразу меняет плитку, правки переживают перезапуск', async () => {
  const photos: string[] = [];
  for (const [i, color] of COLORS.entries()) {
    photos.push(await writeFixture(join(root, 'photos'), { name: `photo-${i + 1}`, width: 900, height: 1200, format: 'jpeg', color }));
  }
  const projectDir = join(root, 'Правки');

  // Сессия 1: импорт, выбор плитки, ползунки.
  let { app, page } = await launch();
  await stubDialogs(app, { save: projectDir, open: photos });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText(`добавлено ${COLORS.length}`);
  await expectTilesRendered(page, COLORS.length);

  const tiles = page.getByTestId('tile');
  const first = tiles.nth(0);
  const second = tiles.nth(1);
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  const firstBefore = await tileColor(first);
  const secondBefore = await tileColor(second);

  // Экспозиция +1 EV: 20 шагов по 0.05. Плитка должна посветлеть почти сразу, без сохранения и перезапуска.
  await press(page, 'Экспозиция', 'ArrowRight', 20);
  await expect(page.getByTestId('value-exposure')).toHaveText('+1.00');
  await expect.poll(async () => (await tileColor(first)).g, { timeout: 1000 }).toBeGreaterThan(firstBefore.g + 30);
  const brighter = await tileColor(first);

  // Температура −30: холоднее — синий растёт относительно красного.
  await press(page, 'Температура', 'ArrowLeft', 30);
  await expect(page.getByTestId('value-temp')).toHaveText('−30');
  await expect
    .poll(async () => {
      const c = await tileColor(first);
      return c.b - c.r;
    }, { timeout: 1000 })
    .toBeGreaterThan(brighter.b - brighter.r + 10);
  const firstAfter = await tileColor(first);

  // Соседняя плитка не изменилась.
  const secondAfter = await tileColor(second);
  for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(secondAfter[c] - secondBefore[c])).toBeLessThan(1);

  // Дожидаемся, что main принял правки, и выходим сразу, не дожидаясь автосохранения.
  await expect.poll(async () => (await mainProject(page))?.slots[0]?.adjust.temp).toBe(-30);
  await app.close();

  const saved = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as Project;
  expect(saved.slots[0]?.adjust).toEqual({ ...createAdjust(), exposure: 1, temp: -30 });
  for (const slot of saved.slots.slice(1)) expect(slot.adjust).toEqual(createAdjust());

  // Сессия 2: та же плитка выглядит так же, ползунки показывают сохранённые значения.
  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expectTilesRendered(page, COLORS.length);
  const reopened = page.getByTestId('tile').nth(0);
  await reopened.click();
  await expect(page.getByTestId('value-exposure')).toHaveText('+1.00');
  await expect(page.getByTestId('value-temp')).toHaveText('−30');
  const restored = await tileColor(reopened);
  for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(restored[c] - firstAfter[c])).toBeLessThan(1);
  await app.close();
});
