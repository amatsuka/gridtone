// Критерий этапа 3г: посты экспортируются из оригиналов по кадру ленты — JPEG 1080 × 1350, 1080 × 1440 или
// 1080 × 1080 с номерами в порядке публикации снизу вверх; сетка — в PNG из окон сетки; цвет и кадр совпадают
// с Gridtone, оригиналы не меняются. docs/decisions/0017-post-export.md.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { applyPipeline } from '../../src/core/color/pipeline';
import type { Rgb as Rgb01 } from '../../src/core/color/srgb';
import { postPipeline } from '../../src/core/lut/bake';
import { sampleLut, type Lut3D } from '../../src/core/lut/lut3d';
import { applyAffine, feedFrameTransform, gridWindowTransform, type Affine } from '../../src/core/project/crop';
import { createAdjust } from '../../src/core/project/defaults';
import { gridLayout } from '../../src/core/project/publish';
import type { Crop, Project } from '../../src/core/project/types';
import { writePixelFixture, type Rgb } from '../fixtures/generate';
import { readCube } from '../fixtures/lut';
import { expectTilesRendered, launch, regionColor, stubDialogs } from './helpers';

let root: string;
/** Запущенное приложение: если тест упал посреди сессии, его закрывает afterEach. */
let app: ElectronApplication | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-e2e3d-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
test.afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Region = [x: [number, number], y: [number, number]];
interface Image {
  data: Buffer;
  width: number;
  height: number;
}

/** Полосы как в 2в: 1200 × 3000, пять горизонтальных полос и белая рамка 16 px — её покажет вылет кадра. */
const SW = 1200;
const SH = 3000;
const BORDER = 16;
const STRIPES: Rgb[] = [
  { r: 200, g: 40, b: 40 },
  { r: 220, g: 200, b: 40 },
  { r: 40, g: 160, b: 60 },
  { r: 40, g: 170, b: 200 },
  { r: 50, g: 60, b: 200 },
];
function stripes(u: number, v: number): Rgb {
  const x = u * SW;
  const y = v * SH;
  if (x < BORDER || x > SW - BORDER || y < BORDER || y > SH - BORDER) return { r: 255, g: 255, b: 255 };
  return STRIPES[Math.min(STRIPES.length - 1, Math.floor(v * STRIPES.length))] as Rgb;
}
const stripeOf = (c: Rgb): number => {
  const d = STRIPES.map((s) => Math.hypot(s.r - c.r, s.g - c.g, s.b - c.b));
  return d.indexOf(Math.min(...d));
};

const UNIFORM: Rgb = { r: 90, g: 110, b: 120 };
const COOL = { ...createAdjust(), exposure: 1, temp: -30 };

/** Кадры, как их оставил бы редактор: полосы — 4:5 у низа фото с поворотом 15°, однотонное — 3:4, рампа — 1:1. */
const CROPS: Crop[] = [
  { feed: { aspect: '4:5', cx: 0.5, cy: 1, zoom: 1, angle: 15 }, grid: { cx: 0.5, cy: 0.5 } },
  { feed: { aspect: '3:4', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 }, grid: { cx: 0.5, cy: 0.5 } },
  { feed: { aspect: '1:1', cx: 0.5, cy: 0.5, zoom: 1, angle: 0 }, grid: { cx: 0.5, cy: 0.5 } },
];

/** Области плитки без номера в левом верхнем углу: для рампы — три участка разной яркости. */
const REGIONS: Region[] = [
  [
    [0.2, 0.8],
    [0.3, 0.9],
  ],
  [
    [0.05, 0.25],
    [0.3, 0.9],
  ],
  [
    [0.4, 0.6],
    [0.3, 0.9],
  ],
  [
    [0.75, 0.95],
    [0.3, 0.9],
  ],
];
/** Для полос — узкие полосы по вертикали, где сверяется номер полосы. */
const STRIPE_BANDS: Region[] = [
  [
    [0.45, 0.55],
    [0.04, 0.1],
  ],
  [
    [0.45, 0.55],
    [0.47, 0.53],
  ],
  [
    [0.45, 0.55],
    [0.9, 0.96],
  ],
];

async function raw(file: string): Promise<Image> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Средний цвет части картинки: x и y — доли ширины и высоты. */
function mean(img: Image, [[x0, x1], [y0, y1]]: Region): Rgb {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(y0 * img.height); y < Math.ceil(y1 * img.height); y++) {
    for (let x = Math.floor(x0 * img.width); x < Math.ceil(x1 * img.width); x++) {
      for (let c = 0; c < 3; c++) sum[c]! += img.data[(y * img.width + x) * 3 + c]!;
      n++;
    }
  }
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

/** Часть картинки в прямоугольнике x, y, w × h (пиксели). */
function cut(img: Image, x: number, y: number, w: number, h: number): Image {
  const data = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++) img.data.copy(data, row * w * 3, ((y + row) * img.width + x) * 3, ((y + row) * img.width + x + w) * 3);
  return { data, width: w, height: h };
}

/** Средний цвет области плитки: прокси 512 по окну сетки, через LUT — так «редактор» видит LUT поста. */
function tileThroughLut(proxy: Image, transform: Affine, lut: Lut3D, [[x0, x1], [y0, y1]]: Region): Rgb {
  const sum = [0, 0, 0];
  const steps = 48;
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const [s, t] = applyAffine(transform, x0 + ((i + 0.5) / steps) * (x1 - x0), y0 + ((j + 0.5) / steps) * (y1 - y0));
      const px = Math.min(proxy.width - 1, Math.max(0, Math.floor(s * proxy.width)));
      const py = Math.min(proxy.height - 1, Math.max(0, Math.floor(t * proxy.height)));
      const k = (py * proxy.width + px) * 3;
      const out = sampleLut(lut, [proxy.data[k]! / 255, proxy.data[k + 1]! / 255, proxy.data[k + 2]! / 255]);
      for (let c = 0; c < 3; c++) sum[c]! += Math.min(1, Math.max(0, out[c]!)) * 255;
    }
  }
  const n = steps * steps;
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}

/** Наибольшее расхождение по группам проверок — для журнала. */
const worst = new Map<string, number>();
const close = (a: Rgb, b: Rgb, limit: number, label: string) => {
  const group = label.split(',')[0] as string;
  worst.set(group, Math.max(worst.get(group) ?? 0, ...(['r', 'g', 'b'] as const).map((c) => Math.abs(a[c] - b[c]))));
  for (const c of ['r', 'g', 'b'] as const) {
    expect(Math.abs(a[c] - b[c]), `${label}, ${c}: ${a[c].toFixed(1)} против ${b[c].toFixed(1)}`).toBeLessThanOrEqual(limit);
  }
};

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** Нажимает «Экспортировать…» и ждёт итога. Возвращает новую подпапку. */
async function runExport(dialog: Locator): Promise<string> {
  await dialog.getByRole('button', { name: 'Экспортировать…' }).click();
  const result = dialog.getByTestId('export-result');
  await expect(result).toHaveAttribute('data-finished', 'true', { timeout: 120_000 });
  return (await result.getAttribute('data-dir')) ?? '';
}

test('посты из оригиналов по кадру ленты, сетка из окон сетки, LUT на каждый пост; оригиналы не меняются', async () => {
  const photos = join(root, 'photos');
  const files = [
    await writePixelFixture(photos, 'полосы', SW, SH, stripes),
    await writePixelFixture(photos, 'однотонное', 1500, 2000, () => UNIFORM),
    await writePixelFixture(photos, 'рампа', 4000, 3000, (u) => ({ r: u * 255, g: u * 255, b: u * 255 })),
  ];
  const hashes = await Promise.all(files.map(sha256));
  const projectDir = join(root, 'Лента');

  // 1. Импорт, затем кадры и образ дописываются в project.json, как их оставил бы редактор.
  let page: Page;
  ({ app, page } = await launch());
  await stubDialogs(app, { save: projectDir, open: files });
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByRole('button', { name: 'Импорт фото' }).click();
  await expect(page.getByTestId('import-status')).toContainText('добавлено 3');
  await expectTilesRendered(page, 3);
  await app.close();
  app = undefined;

  // Импорт ставит фото по алфавиту; сетка — полосы, однотонное, рампа, как после перетаскивания.
  const file = join(projectDir, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8')) as Project;
  const position = (slot: Project['slots'][number]) => files.indexOf(project.assets[slot.assetId ?? '']?.path ?? '');
  project.slots.sort((a, b) => position(a) - position(b));
  project.looks = [{ id: 'look-cool', name: 'Холод', adjust: COOL }];
  project.slots.forEach((slot, i) => (slot.crop = CROPS[i]!));
  project.slots[1]!.lookId = 'look-cool';
  await writeFile(file, JSON.stringify(project, null, 2));

  ({ app, page } = await launch());
  await stubDialogs(app, { open: [projectDir] });
  await page.getByRole('button', { name: 'Открыть проект' }).click();
  const ids = await expectTilesRendered(page, 3);
  const tiles = page.getByTestId('tile');
  // Плитки на экране — до диалога: его подложка затемняет окно.
  const screen = { stripes: [] as Rgb[], uniform: [] as Rgb[], ramp: [] as Rgb[] };
  for (const [x, y] of STRIPE_BANDS) screen.stripes.push(await regionColor(tiles.nth(0), x, y));
  for (const [x, y] of REGIONS) screen.uniform.push(await regionColor(tiles.nth(1), x, y));
  for (const [x, y] of REGIONS) screen.ramp.push(await regionColor(tiles.nth(2), x, y));

  // 2. «Экспорт» → «Посты», «Сетка», «LUT на каждый пост»; раздел LUT образов не нужен.
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const dialog = page.getByTestId('export-dialog');
  const section = dialog.getByTestId('posts-section');
  for (const name of ['Посты', 'Сетка', 'LUT на каждый пост']) {
    const box = section.getByRole('checkbox', { name, exact: true });
    await expect(box).not.toBeChecked();
    await box.check();
  }
  await expect(section.getByTestId('posts-count')).toContainText('3 поста к публикации');
  await dialog.getByRole('checkbox', { name: '.cube', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'HaldCLUT PNG' }).uncheck();

  const exportRoot = join(root, 'Экспорт');
  await mkdir(exportRoot);
  await stubDialogs(app, { open: [exportRoot] });
  const dir = await runExport(dialog);
  await expect(dialog.getByTestId('export-result')).toContainText('Готово');
  await expect(dialog.getByTestId('export-error')).toHaveCount(0);

  // 3. Последняя плитка сетки публикуется первой. Размеры по кадру ленты, sRGB внутри.
  expect((await readdir(dir)).sort()).toEqual(
    ['1 — рампа.cube', '1 — рампа.jpg', '2 — однотонное.cube', '2 — однотонное.jpg', '3 — полосы.cube', '3 — полосы.jpg', 'Сетка.png'].sort(),
  );
  const sizes: [string, number, number][] = [
    ['1 — рампа.jpg', 1080, 1080],
    ['2 — однотонное.jpg', 1080, 1440],
    ['3 — полосы.jpg', 1080, 1350],
  ];
  for (const [name, width, height] of sizes) {
    const meta = await sharp(join(dir, name)).metadata();
    expect([name, meta.format, meta.width, meta.height, meta.hasProfile]).toEqual([name, 'jpeg', width, height, true]);
  }

  // 4. Пост с полосами: сверху вниз полосы кадра ленты (feedFrameTransform), белых точек рамки почти нет.
  const stripesPost = await raw(join(dir, '3 — полосы.jpg'));
  const feed = feedFrameTransform(SW, SH, CROPS[0]!);
  const seen = new Set<number>();
  for (let k = 0; k < 40; k++) {
    const v = (k + 0.5) / 40;
    const t = applyAffine(feed, 0.5, v)[1] * STRIPES.length;
    if (Math.abs(t - Math.round(t)) < 0.1) continue;
    expect(stripeOf(mean(stripesPost, [[0.495, 0.505], [v - 0.004, v + 0.004]])), `полоса в точке v = ${v.toFixed(3)}`).toBe(Math.floor(t));
    seen.add(Math.floor(t));
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  let white = 0;
  for (let i = 0; i < stripesPost.data.length; i += 3) {
    if (Math.min(stripesPost.data[i]!, stripesPost.data[i + 1]!, stripesPost.data[i + 2]!) > 200) white++;
  }
  expect(white / (stripesPost.data.length / 3)).toBeLessThan(0.005);
  console.log(`белых точек в посте с полосами: ${((white / (stripesPost.data.length / 3)) * 100).toFixed(2)}%`);

  // Пост с рампой 1:1 — весь кадр ленты, x 500…3500 из 4000, а не окно сетки: серый растёт по ширине так же.
  const rampPost = await raw(join(dir, '1 — рампа.jpg'));
  for (const u of [0.05, 0.3, 0.5, 0.7, 0.95]) {
    const gray = ((500 + u * 3000) / 4000) * 255;
    close(mean(rampPost, [[u - 0.005, u + 0.005], [0.2, 0.8]]), { r: gray, g: gray, b: gray }, 3, `рампа, u = ${u}`);
  }

  // Однотонный пост: конвейер core от цвета оригинала (±2) и плитка на экране (±3).
  const uniformPost = mean(await raw(join(dir, '2 — однотонное.jpg')), [
    [0.1, 0.9],
    [0.1, 0.9],
  ]);
  const original = mean(await raw(files[1]!), [
    [0.4, 0.6],
    [0.4, 0.6],
  ]);
  const [r, g, b] = applyPipeline([original.r / 255, original.g / 255, original.b / 255] as Rgb01, postPipeline(createAdjust(), COOL)).map(
    (v) => v * 255,
  );
  close(uniformPost, { r: r!, g: g!, b: b! }, 2, 'однотонный пост против core');
  close(uniformPost, screen.uniform[0]!, 3, 'однотонный пост против плитки');

  // 5. Сетка.png: 3 колонки, плитка 540 × 720; каждая плитка — как на экране.
  const grid = await raw(join(dir, 'Сетка.png'));
  const layout = gridLayout(3, '3:4', 3);
  expect([grid.width, grid.height, layout.tileWidth, layout.tileHeight]).toEqual([layout.width, layout.height, 540, 720]);
  const cell = (i: number) => cut(grid, layout.cells[i]![0], layout.cells[i]![1], layout.tileWidth, layout.tileHeight);
  for (const [k, band] of STRIPE_BANDS.entries()) {
    expect(stripeOf(mean(cell(0), band)), `полоса в плитке, участок ${k + 1}`).toBe(stripeOf(screen.stripes[k]!));
  }
  for (const [k, region] of REGIONS.entries()) {
    close(mean(cell(1), region), screen.uniform[k]!, 3, `сетка, однотонное, участок ${k + 1}`);
    close(mean(cell(2), region), screen.ramp[k]!, 3, `сетка, рампа, участок ${k + 1}`);
  }

  // 6. LUT поста, применённый к прокси, даёт плитку: связка «поправка фото + образ».
  const posts: [string, number, Rgb[], Region[]][] = [
    ['1 — рампа.cube', 2, screen.ramp, REGIONS],
    ['2 — однотонное.cube', 1, screen.uniform, REGIONS],
  ];
  for (const [name, slot, onScreen, regions] of posts) {
    const lut = await readCube(join(dir, name));
    const proxy = await raw(join(projectDir, 'cache', 'proxies', ids[slot]!, '512.jpg'));
    const transform = gridWindowTransform(proxy.width, proxy.height, CROPS[slot]!, '3:4');
    for (const [k, region] of regions.entries()) close(tileThroughLut(proxy, transform, lut, region), onScreen[k]!, 3, `${name}, участок ${k + 1}`);
  }
  expect(await readFile(join(dir, '2 — однотонное.cube'), 'utf8')).toContain('\nTITLE "2 — однотонное"\n');

  // 7. Оригиналы не изменились.
  expect(await Promise.all(files.map(sha256))).toEqual(hashes);

  // Пропавший оригинал: пост пропущен с причиной, остальные записаны; плитка сетки — из превью.
  const moved = join(photos, 'рампа (перенесено).jpg');
  await rename(files[2]!, moved);
  const second = await runExport(dialog);
  expect(second).not.toBe(dir);
  const result = dialog.getByTestId('export-result');
  await expect(result).toContainText('Готово с ошибками');
  await expect(dialog.getByTestId('export-error')).toHaveText([`1 — рампа.jpg: оригинал не найден: ${files[2]}`]);
  await expect(dialog.getByTestId('export-warning')).toContainText([/Сетка\.png: плитка 3 \(рампа\): оригинал не найден: .* — плитка из превью 2048/]);
  expect((await readdir(second)).sort()).toEqual(
    ['1 — рампа.cube', '2 — однотонное.cube', '2 — однотонное.jpg', '3 — полосы.cube', '3 — полосы.jpg', 'Сетка.png'].sort(),
  );
  const fallbackRamp = cut(await raw(join(second, 'Сетка.png')), layout.cells[2]![0], layout.cells[2]![1], 540, 720);
  for (const [k, region] of REGIONS.entries()) close(mean(fallbackRamp, region), screen.ramp[k]!, 3, `сетка из превью, рампа, участок ${k + 1}`);
  // Первая подпапка не тронута, оригиналы — тоже.
  expect((await readdir(dir)).length).toBe(7);
  expect(await sha256(moved)).toBe(hashes[2]);
  expect(await Promise.all(files.slice(0, 2).map(sha256))).toEqual(hashes.slice(0, 2));
  console.log([...worst].map(([group, d]) => `${group}: ${d.toFixed(1)}`).join('; '));
});
