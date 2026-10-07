// Синтетические фото для тестов: генерируются на лету, бинарники в репозиторий не попадают.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type FixtureFormat = 'jpeg' | 'png' | 'webp' | 'tiff';

export interface FixtureSpec {
  name: string; // имя файла без расширения
  width: number; // размеры, какими фото видит человек (после EXIF-поворота)
  height: number;
  format: FixtureFormat;
  color: Rgb; // фон
  label?: string; // крупная надпись по центру
  orientation?: number; // EXIF 1–8: пиксели в файле повёрнуты, тег возвращает их как надо
  profile?: 'p3'; // пиксели перекодированы в Display P3, профиль вшит
  bits16?: boolean; // 16 бит на канал (только png)
  alpha?: boolean; // прозрачный фон (png/webp)
}

/** Маркер в левом верхнем углу: по нему тесты проверяют ориентацию. */
export const MARKER: Rgb = { r: 255, g: 0, b: 255 };

const EXTENSIONS: Record<FixtureFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tif' };

// Как из видимой картинки получить пиксели файла с данным тегом. Операции идут по очереди.
type Step = 'flip' | 'flop' | 90 | 180 | 270;
const STORED_FROM_VISIBLE: Record<number, Step[]> = {
  1: [],
  2: ['flop'],
  3: [180],
  4: ['flip'],
  5: [90, 'flop'], // transpose
  6: [270],
  7: [270, 'flop'], // transverse
  8: [90],
};

export async function writeFixture(dir: string, spec: FixtureSpec): Promise<string> {
  await mkdir(dir, { recursive: true });
  let image = await sharp(Buffer.from(svg(spec))).png().toBuffer();

  for (const step of STORED_FROM_VISIBLE[spec.orientation ?? 1] ?? []) {
    const op = sharp(image);
    image = await (step === 'flip' ? op.flip() : step === 'flop' ? op.flop() : op.rotate(step)).png().toBuffer();
  }

  let out = sharp(image);
  if (spec.orientation !== undefined) out = out.withMetadata({ orientation: spec.orientation });
  if (spec.profile === 'p3') out = out.withIccProfile('p3');
  if (spec.bits16) out = out.toColourspace('rgb16');
  if (!spec.alpha) out = out.removeAlpha();

  const encoded = await (spec.format === 'jpeg'
    ? out.jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    : spec.format === 'png'
      ? out.png()
      : spec.format === 'webp'
        ? out.webp({ lossless: true })
        : out.tiff()
  ).toBuffer();

  const file = join(dir, `${spec.name}.${EXTENSIONS[spec.format]}`);
  await writeFile(file, encoded);
  return file;
}

/**
 * Фото по функции цвета пикселя, без маркера и надписи: рампы и однотонные кадры для проверок цвета.
 * color получает координаты 0..1 и возвращает sRGB 0..255. JPEG q95 без прореживания цветности.
 */
export async function writePixelFixture(
  dir: string,
  name: string,
  width: number,
  height: number,
  color: (u: number, v: number) => Rgb,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = color((x + 0.5) / width, (y + 0.5) / height);
      const i = (y * width + x) * 3;
      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
    }
  }
  const file = join(dir, `${name}.jpg`);
  await sharp(data, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toFile(file);
  return file;
}

/** Набор для критерия этапа 0: разные форматы, размеры, ориентации и профили. */
export function importSetSpecs(count = 30): FixtureSpec[] {
  const variants: Omit<FixtureSpec, 'name' | 'color' | 'label'>[] = [
    { width: 3024, height: 4032, format: 'jpeg' }, // как с iPhone
    { width: 3024, height: 4032, format: 'jpeg', orientation: 6 },
    { width: 3024, height: 4032, format: 'jpeg', profile: 'p3' },
    { width: 4032, height: 3024, format: 'jpeg' }, // альбомная
    { width: 1080, height: 1350, format: 'png' },
    { width: 1080, height: 1350, format: 'png', alpha: true },
    { width: 1600, height: 1600, format: 'webp' },
    { width: 2000, height: 1500, format: 'tiff', profile: 'p3' },
    { width: 1200, height: 1600, format: 'png', bits16: true },
    { width: 400, height: 500, format: 'jpeg' }, // меньше прокси
  ];
  return Array.from({ length: count }, (_, i) => ({
    ...(variants[i % variants.length] as (typeof variants)[number]),
    name: `photo-${String(i + 1).padStart(2, '0')}`,
    color: hueColor(i / count),
    label: String(i + 1),
  }));
}

export async function generateImportSet(dir: string, count = 30): Promise<string[]> {
  const files: string[] = [];
  for (const spec of importSetSpecs(count)) files.push(await writeFixture(dir, spec));
  return files;
}

function svg({ width, height, color, label, alpha }: FixtureSpec): string {
  const marker = Math.round(Math.min(width, height) * 0.12);
  const fontSize = Math.round(Math.min(width, height) * 0.3);
  const background = alpha ? '' : `<rect width="${width}" height="${height}" fill="${hex(color)}"/>`;
  const text = label
    ? `<text x="${width / 2}" y="${height / 2 + fontSize * 0.35}" font-size="${fontSize}" font-family="Helvetica, Arial, sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">${label}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${background}<rect width="${marker}" height="${marker}" fill="${hex(MARKER)}"/>${text}</svg>`;
}

function hex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Цвет по кругу оттенков, умеренно насыщенный. t в 0..1. */
function hueColor(t: number): Rgb {
  const h = t * 6;
  const s = 0.55;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
