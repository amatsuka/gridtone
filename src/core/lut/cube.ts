// Формат `.cube` (Adobe Cube LUT Specification 1.0; его же читают Resolve, darktable и Photoshop).
// Пишется только 3D: заголовок, затем size³ строк «R G B» с 6 знаками, R меняется быстрее всех.
// Читается тоже только 3D размером 2…65; 1D и shaper (1D + 3D) отвергаются — docs/decisions/0014-lut-export.md.
import type { Rgb } from '../color/srgb';
import { LUT_SIZE_MAX, LUT_SIZE_MIN, type Lut3D } from './lut3d';

/** Знаков после запятой в строках данных: ошибка округления 5·10⁻⁷, на порядки ниже 16-битного шага. */
export const CUBE_DECIMALS = 6;

export class CubeError extends Error {}

const fmt = (v: number) => v.toFixed(CUBE_DECIMALS);

/** Комментарий в начале экспортированного `.cube`: что внутри и в какую точку обработки его ставить. */
export function lookCubeComments(lookName: string): string[] {
  return [
    `Gridtone — образ «${lookName}»`,
    'Вход и выход — sRGB с гаммой, домен 0..1: как JPEG, загруженный в Gridtone.',
    'Ставить туда, где изображение совпадает с этим JPEG: после проявки, до стилизации.',
  ];
}

/** В TITLE нет двойных кавычек и переводов строк, в комментарии — переводов строк. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** Текст `.cube`. comments идут первыми строками «# …». Перевод строки — LF, кодировка — UTF-8. */
export function writeCube(lut: Lut3D, comments: readonly string[] = []): string {
  const { size, data } = lut;
  const header = comments.map((line) => `# ${oneLine(line)}`);
  if (lut.title !== undefined) header.push(`TITLE "${oneLine(lut.title).replace(/"/g, "'")}"`);
  header.push(
    `LUT_3D_SIZE ${size}`,
    `DOMAIN_MIN ${lut.domainMin.map(fmt).join(' ')}`,
    `DOMAIN_MAX ${lut.domainMax.map(fmt).join(' ')}`,
    '',
  );
  const rows = new Array<string>(size * size * size);
  for (let i = 0; i < rows.length; i++) {
    rows[i] = `${fmt(data[i * 3] as number)} ${fmt(data[i * 3 + 1] as number)} ${fmt(data[i * 3 + 2] as number)}`;
  }
  return `${header.join('\n')}\n${rows.join('\n')}\n`;
}

const KEYWORD = /^([A-Z][A-Z0-9_]*)(?:\s+(.*))?$/;

/** Разбирает `.cube`. Бросает CubeError с понятным сообщением, если файл не годится. */
export function parseCube(text: string): Lut3D {
  let title: string | undefined;
  let size: number | undefined;
  let size1d: number | undefined;
  let domainMin: Rgb = [0, 0, 0];
  let domainMax: Rgb = [1, 1, 1];
  const values: number[] = [];
  let rows = 0;

  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const where = `Строка ${index + 1}`;
    if (line === '' || line.startsWith('#')) continue;
    const keyword = KEYWORD.exec(line);
    if (keyword) {
      if (rows > 0) throw new CubeError(`${where}: ключевое слово ${keyword[1]} после строк данных`);
      const [, name, rest = ''] = keyword;
      switch (name) {
        case 'TITLE':
          title = /^"(.*)"$/.exec(rest.trim())?.[1] ?? rest.trim();
          break;
        case 'LUT_3D_SIZE':
          size = Number(rest.trim());
          break;
        case 'LUT_1D_SIZE':
          size1d = Number(rest.trim());
          break;
        case 'DOMAIN_MIN':
          domainMin = triple(rest, `${where}: DOMAIN_MIN — нужны три числа`);
          break;
        case 'DOMAIN_MAX':
          domainMax = triple(rest, `${where}: DOMAIN_MAX — нужны три числа`);
          break;
        case 'LUT_3D_INPUT_RANGE': {
          // Старая запись Resolve: одна пара на все каналы.
          const [min, max] = numbers(rest);
          if (min === undefined || max === undefined) throw new CubeError(`${where}: LUT_3D_INPUT_RANGE — нужны два числа`);
          domainMin = [min, min, min];
          domainMax = [max, max, max];
          break;
        }
        default:
          // Незнакомые ключевые слова (LUT_IN_VIDEO_RANGE и т. п.) на цвет не влияют.
          break;
      }
      continue;
    }
    const row = numbers(line);
    if (row.length !== 3 || row.some((v) => !Number.isFinite(v))) {
      throw new CubeError(`${where}: ожидались три числа, а здесь «${line.slice(0, 40)}»`);
    }
    values.push(row[0] as number, row[1] as number, row[2] as number);
    rows++;
  }

  if (size1d !== undefined && size !== undefined) {
    throw new CubeError('LUT с shaper (1D + 3D) не поддерживается: нужен чистый 3D LUT');
  }
  if (size1d !== undefined) throw new CubeError('1D LUT не поддерживается: нужен 3D LUT (LUT_3D_SIZE)');
  if (size === undefined) throw new CubeError('Нет LUT_3D_SIZE: это не 3D LUT в формате .cube');
  if (!Number.isInteger(size) || size < LUT_SIZE_MIN || size > LUT_SIZE_MAX) {
    throw new CubeError(`LUT_3D_SIZE ${size}: размер должен быть целым числом ${LUT_SIZE_MIN}…${LUT_SIZE_MAX}`);
  }
  if (domainMin.some((min, c) => !(min < (domainMax[c] as number)))) {
    throw new CubeError('DOMAIN_MIN должен быть меньше DOMAIN_MAX по каждому каналу');
  }
  const expected = size ** 3;
  if (rows !== expected) {
    throw new CubeError(`Для LUT_3D_SIZE ${size} нужно ${size}³ = ${expected} строк данных, а их ${rows}`);
  }
  const lut: Lut3D = { size, domainMin, domainMax, data: Float64Array.from(values) };
  return title === undefined ? lut : { ...lut, title };
}

function numbers(text: string): number[] {
  const parts = text.trim().split(/\s+/);
  return parts[0] === '' ? [] : parts.map(Number);
}

function triple(text: string, message: string): Rgb {
  const v = numbers(text);
  if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new CubeError(message);
  return v as Rgb;
}
