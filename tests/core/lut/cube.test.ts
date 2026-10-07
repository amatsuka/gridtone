import { describe, expect, it } from 'vitest';
import { CubeError, parseCube, writeCube } from '@core/lut/cube';
import { createLut, identityLut, type Lut3D } from '@core/lut/lut3d';
import { seededRandom } from '../color/helpers';

function randomLut(size: number, seed: number): Lut3D {
  const random = seededRandom(seed);
  return { ...createLut(size, () => [random(), random(), random()]), title: 'Плёнка' };
}

/** Тело файла по строкам данных: «0 0 0» и т. д. */
function cube(header: string, size: number, rows = size ** 3): string {
  const lines = [header];
  for (let i = 0; i < rows; i++) lines.push(`${(i % size) / Math.max(1, size - 1)} 0 0`);
  return lines.join('\n');
}

function parseError(text: string): string {
  try {
    parseCube(text);
  } catch (err) {
    expect(err).toBeInstanceOf(CubeError);
    return (err as Error).message;
  }
  throw new Error('файл прочитался без ошибки');
}

describe('.cube', () => {
  it('запись → чтение с точностью 6 знаков', () => {
    for (const size of [2, 17, 33]) {
      const lut = randomLut(size, size);
      const read = parseCube(writeCube(lut));
      expect(read.size).toBe(size);
      expect(read.title).toBe('Плёнка');
      expect(read.domainMin).toEqual([0, 0, 0]);
      expect(read.domainMax).toEqual([1, 1, 1]);
      expect(read.data.length).toBe(lut.data.length);
      for (let i = 0; i < lut.data.length; i++) {
        expect(Math.abs((read.data[i] as number) - (lut.data[i] as number))).toBeLessThanOrEqual(5e-7 + 1e-12);
      }
    }
  });

  it('заголовок: комментарии, TITLE, размер и домен, затем строки с 6 знаками', () => {
    const text = writeCube({ ...identityLut(2), title: 'Плёнка' }, ['Gridtone', 'Вход и выход — sRGB с гаммой']);
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '# Gridtone',
      '# Вход и выход — sRGB с гаммой',
      'TITLE "Плёнка"',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0.000000 0.000000 0.000000',
      'DOMAIN_MAX 1.000000 1.000000 1.000000',
    ]);
    // R меняется быстрее всех.
    expect(lines.slice(7, 11)).toEqual([
      '0.000000 0.000000 0.000000',
      '1.000000 0.000000 0.000000',
      '0.000000 1.000000 0.000000',
      '1.000000 1.000000 0.000000',
    ]);
    expect(text.endsWith('1.000000 1.000000 1.000000\n')).toBe(true);
  });

  it('кавычки и переводы строк в TITLE и комментариях не ломают файл', () => {
    const text = writeCube({ ...identityLut(2), title: 'Он сказал "да"\nи ушёл' }, ['две\nстроки']);
    expect(text).toContain('TITLE "Он сказал \'да\' и ушёл"');
    expect(text).toContain('# две строки');
    expect(parseCube(text).title).toBe("Он сказал 'да' и ушёл");
  });

  it('читает домен, комментарии, пустые строки, CRLF и TITLE без кавычек', () => {
    const lines = [
      '# комментарий',
      '',
      'TITLE Без кавычек',
      '  LUT_3D_SIZE 2  ',
      'DOMAIN_MIN -0.1 0 0.2',
      'DOMAIN_MAX 1.2 1 0.8',
      '# данные',
      '0 0 0',
      '1 0 0',
      '0 1 0',
      '1 1 0',
      '',
      '0 0 1',
      '1 0 1',
      '0 1 1',
      '1e0 1.0 +1',
    ];
    const lut = parseCube(lines.join('\r\n') + '\r\n');
    expect(lut.title).toBe('Без кавычек');
    expect(lut.size).toBe(2);
    expect(lut.domainMin).toEqual([-0.1, 0, 0.2]);
    expect(lut.domainMax).toEqual([1.2, 1, 0.8]);
    expect(Array.from(lut.data)).toEqual(Array.from(identityLut(2).data));
    // Одинокий CR (старый Mac) — тоже перевод строки.
    expect(parseCube(lines.join('\r')).size).toBe(2);
  });

  it('LUT_3D_INPUT_RANGE задаёт домен, незнакомые ключевые слова пропускаются', () => {
    const lut = parseCube(cube('LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -0.5 1.5\nLUT_IN_VIDEO_RANGE', 2));
    expect(lut.domainMin).toEqual([-0.5, -0.5, -0.5]);
    expect(lut.domainMax).toEqual([1.5, 1.5, 1.5]);
  });

  it('ошибки: 1D, shaper, нет размера, размер вне 2…65', () => {
    expect(parseError(cube('LUT_1D_SIZE 4', 4, 4))).toMatch(/1D/);
    expect(parseError(cube('LUT_1D_SIZE 4\nLUT_3D_SIZE 2', 2, 4 + 8))).toMatch(/shaper/);
    expect(parseError('0 0 0\n1 1 1')).toMatch(/LUT_3D_SIZE/);
    expect(parseError(cube('LUT_3D_SIZE 1', 1, 1))).toMatch(/2…65/);
    expect(parseError(cube('LUT_3D_SIZE 66', 2, 8))).toMatch(/2…65/);
    expect(parseError(cube('LUT_3D_SIZE 2.5', 2, 8))).toMatch(/2…65/);
  });

  it('ошибки: не то число строк, нечисла, лишние и недостающие значения', () => {
    expect(parseError(cube('LUT_3D_SIZE 3', 3, 26))).toMatch(/27.*26/);
    expect(parseError(cube('LUT_3D_SIZE 2', 2, 9))).toMatch(/8.*9/);
    expect(parseError('LUT_3D_SIZE 2\n0 0 0\n1 x 0\n' + '0 0 0\n'.repeat(6))).toMatch(/строка 3/i);
    expect(parseError('LUT_3D_SIZE 2\n0 0\n' + '0 0 0\n'.repeat(7))).toMatch(/строка 2/i);
    expect(parseError('LUT_3D_SIZE 2\n0 0 0 0\n' + '0 0 0\n'.repeat(7))).toMatch(/строка 2/i);
    expect(parseError('LUT_3D_SIZE 2\nNaN 0 0\n' + '0 0 0\n'.repeat(7))).toMatch(/строка 2/i);
  });

  it('ошибки: домен пустой, ключевое слово после данных', () => {
    expect(parseError(cube('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0.5 0\nDOMAIN_MAX 1 0.5 1', 2))).toMatch(/DOMAIN/);
    expect(parseError(cube('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0', 2))).toMatch(/DOMAIN_MIN/);
    expect(parseError('LUT_3D_SIZE 2\n0 0 0\nTITLE "поздно"\n' + '0 0 0\n'.repeat(7))).toMatch(/строка 3/i);
  });
});
