// Критерий этапа 3в: калибровочная карта экспортируется. Карта, на которую LUT наложен в правильной
// точке, получает «Совпадает»; сдвинутая до LUT, без LUT или с LUT дважды — «Не совпадает» с причиной.
// «Редактор» — сам тест: он накладывает экспортированный `.cube` на карту тетраэдрической интерполяцией
// core, как Color Lookup в Photoshop, уменьшает её и сохраняет JPEG. docs/decisions/0016-calibration-card.md.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { Rgb } from '../../src/core/color/srgb';
import { CARD_HEIGHT, CARD_LIMITS, CARD_WIDTH } from '../../src/core/lut/calibration';
import type { Project } from '../../src/core/project/types';
import { brighten, editRgb, readRgb, toSharp, viaLut, type RawImage } from '../fixtures/editor';
import { readCube } from '../fixtures/lut';
import { filmLook, kinkLook } from '../golden/looks';
import { launch, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e3c-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Карта после «редактора»: f к каждой точке, уменьшение вдвое, JPEG q90 с профилем sRGB. */
async function editorOutput(card: RawImage, name: string, f: (c: Rgb) => Rgb, crop?: number): Promise<string> {
  let image = toSharp(editRgb(card, f));
  if (crop !== undefined) image = sharp(await image.extract({ left: 0, top: 0, width: crop, height: CARD_HEIGHT }).png().toBuffer());
  const width = Math.round((crop ?? CARD_WIDTH) / 2);
  const file = join(root, 'editor', `${name}.jpg`);
  await mkdir(join(root, 'editor'), { recursive: true });
  await image.resize(width, CARD_HEIGHT / 2).withIccProfile('srgb').jpeg({ quality: 90 }).toFile(file);
  return file;
}

/** «Проверить карту…» с подменённым диалогом файла; ждёт отчёта по этому файлу. Файлы подряд — разные. */
async function checkCard(app: ElectronApplication, section: Locator, file: string): Promise<Locator> {
  await stubDialogs(app, { open: [file] });
  await section.getByRole('button', { name: 'Проверить карту…' }).click();
  const report = section.getByTestId('card-report');
  await expect(report).toHaveAttribute('data-file', basename(file));
  return report;
}

test('калибровочная карта: экспорт, «Совпадает» в правильной точке, причины несовпадения', async () => {
  const projectDir = join(root, 'Карта');

  // Проект без фото: карта и LUT от фото не зависят.
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await expect(page.getByTestId('project-name')).toHaveText('Карта');
  await app.close();
  app = undefined;

  // «Излом» первым: проверка по умолчанию взяла бы его, тест выбирает «Плёнку» сам.
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  project.looks = [
    { id: 'look-kink', name: 'Излом', adjust: kinkLook() },
    { id: 'look-film', name: 'Плёнка', adjust: filmLook() },
  ];
  await writeFile(file, JSON.stringify(project, null, 2));

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  await expect(page.getByTestId('project-name')).toHaveText('Карта');

  // 1. «Экспорт» → «Калибровочная карта» и `.cube` 33 «Плёнки».
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const section = dialog.getByTestId('calibration-section');
  const card = section.getByRole('checkbox', { name: 'Калибровочная карта' });
  await expect(card).not.toBeChecked();
  await card.check();
  await dialog.locator('[data-testid="lut-look"][data-name="Излом"]').getByRole('checkbox', { name: 'Излом' }).uncheck();
  const film = dialog.locator('[data-testid="lut-look"][data-name="Плёнка"]');
  await expect(film.getByTestId('lut-check')).toHaveAttribute('data-state', 'pass');
  await expect(film.getByRole('radio', { name: '33' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'HaldCLUT PNG' }).uncheck();

  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true');
  await expect(result).toContainText('Готово');
  const dir = (await result.getAttribute('data-dir')) ?? '';
  expect((await readdir(dir)).sort()).toEqual(['Калибровка.png', 'Плёнка.cube']);
  const cardFile = join(dir, 'Калибровка.png');
  const meta = await sharp(cardFile).metadata();
  expect([meta.format, meta.width, meta.height, meta.channels, meta.depth, meta.hasProfile]).toEqual([
    'png',
    CARD_WIDTH,
    CARD_HEIGHT,
    3,
    'uchar',
    true,
  ]);
  expect(await readFile(join(dir, 'Плёнка.cube'), 'utf8')).toContain('\nLUT_3D_SIZE 33\n');

  // 2. Тест играет редактор: `.cube` на карту, уменьшение вдвое, JPEG q90.
  const lut = viaLut(await readCube(join(dir, 'Плёнка.cube')));
  const source = await readRgb(cardFile);
  await section.getByRole('combobox', { name: 'Образ для проверки' }).selectOption({ label: 'Плёнка' });
  const match = await checkCard(app, section, await editorOutput(source, 'плёнка', lut));
  await expect(match).toHaveAttribute('data-verdict', 'match');
  await expect(match).toContainText('Совпадает');
  await expect(match).toContainText('образ «Плёнка»');
  const mean = Number(await match.getAttribute('data-mean'));
  expect(mean).toBeLessThan(CARD_LIMITS.mean);
  console.log(`карта с LUT: средний ΔE2000 ${mean.toFixed(3)}`);

  // 3. Карта, осветлённая на +0.3 EV до LUT: «Не совпадает», худшие патчи в отчёте.
  const lift = brighten(0.3);
  const shifted = await checkCard(app, section, await editorOutput(source, 'осветлённая', (c) => lut(lift(c))));
  await expect(shifted).toHaveAttribute('data-verdict', 'shifted');
  await expect(shifted).toContainText('Не совпадает');
  await expect(shifted.getByTestId('card-worst')).toHaveCount(8);
  expect(Number(await shifted.getAttribute('data-mean'))).toBeGreaterThan(CARD_LIMITS.mean);

  // 4. Без LUT — «LUT не применён», LUT дважды — «LUT применён дважды».
  const none = await checkCard(app, section, await editorOutput(source, 'без-lut', (c) => c));
  await expect(none).toHaveAttribute('data-verdict', 'no-lut');
  await expect(none).toContainText('Не совпадает: LUT не применён');
  const twice = await checkCard(app, section, await editorOutput(source, 'дважды', (c) => lut(lut(c))));
  await expect(twice).toHaveAttribute('data-verdict', 'twice');
  await expect(twice).toContainText('Не совпадает: LUT применён дважды');

  // 5. Обрезанная карта — «Карта обрезана или повёрнута».
  const cropped = await checkCard(app, section, await editorOutput(source, 'обрезанная', lut, Math.round(CARD_WIDTH * 0.9)));
  await expect(cropped).toHaveAttribute('data-verdict', 'geometry');
  await expect(cropped).toContainText('Карта обрезана или повёрнута');

  // Та же правильная карта против «Излома» — не совпадает: сверка идёт с выбранным образом.
  await section.getByRole('combobox', { name: 'Образ для проверки' }).selectOption({ label: 'Излом' });
  const other = await checkCard(app, section, join(root, 'editor', 'плёнка.jpg'));
  await expect(other).not.toHaveAttribute('data-verdict', 'match');
  await expect(other).toContainText('образ «Излом»');
});
