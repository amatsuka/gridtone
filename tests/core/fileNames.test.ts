import { describe, expect, it } from 'vitest';
import { exportFolderName, safeFileName, uniqueNames } from '@core/project/fileNames';

describe('имена файлов экспорта', () => {
  it('имя образа становится именем файла как есть, если в нём нет запрещённого', () => {
    expect(safeFileName('Плёнка', 'Образ')).toBe('Плёнка');
    expect(safeFileName('Тёплый вечер — 2', 'Образ')).toBe('Тёплый вечер — 2');
  });

  it('запрещённые символы, управляющие, точки и пробелы по краям заменяются', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', 'Образ')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFileName('  .скрытый.  ', 'Образ')).toBe('скрытый');
    expect(safeFileName('две\nстроки', 'Образ')).toBe('две строки');
    expect(safeFileName(' / ', 'Образ')).toBe('-');
    expect(safeFileName('...', 'Образ')).toBe('Образ');
    expect(safeFileName('', 'Образ')).toBe('Образ');
  });

  it('длинное имя обрезается до 100 символов', () => {
    expect(safeFileName('я'.repeat(300), 'Образ')).toHaveLength(100);
  });

  it('повторы получают номер, регистр не различается', () => {
    expect(uniqueNames(['Плёнка', 'плёнка', 'Излом', 'Плёнка', 'Плёнка 2'])).toEqual([
      'Плёнка',
      'плёнка 2',
      'Излом',
      'Плёнка 3',
      'Плёнка 2 2',
    ]);
  });

  it('подпапка экспорта — имя проекта и местное время без двоеточий', () => {
    const date = new Date(2026, 9, 8, 7, 5, 3);
    expect(exportFolderName('Сетка', date)).toBe('Сетка — экспорт 2026-10-08 07-05-03');
    expect(exportFolderName('a/b', date)).toBe('a-b — экспорт 2026-10-08 07-05-03');
  });
});
