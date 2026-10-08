// Реестр импортированных LUT (docs/decisions/0015-lut-import.md): запись, имя образа, новый образ в конце.
import { describe, expect, test } from 'vitest';
import { createAdjust, createProject } from '@core/project/defaults';
import { createLook } from '@core/project/looks';
import { addImportedLut, isValidLutRef, lookNameForLut, lutIdFromHash, lutRefOf } from '@core/project/luts';
import type { LutRef } from '@core/project/types';
import { LOOK_NAME_MAX } from '@core/project/validate';

const HASH = 'fedcba9876543210'.padEnd(64, '7');

function ref(patch: Partial<LutRef> = {}): LutRef {
  return { id: lutIdFromHash(HASH), name: 'сепия.cube', size: 17, hash: HASH, importedAt: '2026-10-08T00:00:00.000Z', ...patch };
}

describe('реестр LUT', () => {
  test('id — первые 16 hex хэша, как у ассетов', () => {
    expect(lutIdFromHash(HASH)).toBe('fedcba9876543210');
    expect(lookNameForLut(undefined, 'a.cube')).toBe('a');
    expect(isValidLutRef(ref(), 'fedcba9876543210')).toBe(true);
    expect(isValidLutRef(ref(), 'fedcba9876543211')).toBe(false);
    expect(isValidLutRef({ ...ref(), extra: 1 }, 'fedcba9876543210')).toBe(false);
    expect(isValidLutRef(ref({ size: 1 }), 'fedcba9876543210')).toBe(false);
    expect(isValidLutRef(ref({ name: '' }), 'fedcba9876543210')).toBe(false);
  });

  test('имя образа — TITLE, иначе имя файла без расширения; не длиннее предела', () => {
    expect(lookNameForLut('Сепия', 'сепия.cube')).toBe('Сепия');
    expect(lookNameForLut('  Сепия\n2 ', 'x.cube')).toBe('Сепия 2');
    expect(lookNameForLut(undefined, 'Kodak 2383.CUBE')).toBe('Kodak 2383');
    expect(lookNameForLut('   ', 'film.cube')).toBe('film');
    expect(lookNameForLut(undefined, '.cube')).toBe('LUT');
    const long = lookNameForLut('я'.repeat(300), 'x.cube');
    expect(long.length).toBe(LOOK_NAME_MAX);
  });

  test('импорт дописывает образ в конец и запись реестра — один раз', () => {
    const project = createProject('p');
    project.looks.push(createLook('a', 'Тёплый'));
    const first = addImportedLut(project, ref(), 'look-1', 'Сепия');
    expect(first).toEqual({ id: 'look-1', name: 'Сепия', adjust: createAdjust(), importedLut: 'fedcba9876543210' });
    expect(project.looks.map((look) => look.id)).toEqual(['a', 'look-1']);
    expect(Object.keys(project.luts)).toEqual(['fedcba9876543210']);

    // Тот же файл ещё раз: запись прежняя (с прежней датой), образ — новый, снова в конце.
    addImportedLut(project, ref({ importedAt: '2026-10-09T00:00:00.000Z', name: 'другое имя.cube' }), 'look-2', 'Сепия');
    expect(project.looks.map((look) => look.id)).toEqual(['a', 'look-1', 'look-2']);
    expect(Object.keys(project.luts)).toEqual(['fedcba9876543210']);
    expect(project.luts['fedcba9876543210']?.importedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(lutRefOf(project, project.looks[2]!)).toEqual(ref());
    expect(lutRefOf(project, project.looks[0]!)).toBeUndefined();
  });
});
