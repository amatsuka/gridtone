// Плитки без данных: превью не построено или воркер его не прочитал. «Анализ», «Подгонка» и «Поправки к цели»
// называют их — номера позиций и причина, — а не молчат и не ждут.
import { describe, expect, test } from 'vitest';
import type { AssetStatus } from '@shared/ipc';
import { noDataText, unavailableSlots, type NoDataSlot } from '../../src/renderer/unavailable';

const project = {
  slots: [
    { id: 's1', assetId: 'a1' },
    { id: 's2', assetId: 'a2' },
    { id: 's3' },
    { id: 's4', assetId: 'a4' },
    { id: 's5', assetId: 'a5' },
  ],
} as never;

const ready: AssetStatus = { proxy: 'ready', original: 'ok' };
const ASSETS: Record<string, AssetStatus> = {
  a1: ready,
  a2: { proxy: 'failed', original: 'missing' },
  a4: ready,
  a5: { proxy: 'pending', original: 'ok' },
};

describe('плитки без данных', () => {
  test('превью не построено или воркер не посчитал — нет данных; считаются и пустые — нет', () => {
    const all = ['s1', 's2', 's3', 's4', 's5'];
    expect(unavailableSlots(project, ASSETS, {}, all)).toEqual([{ slotId: 's2', index: 1, reason: 'proxy' }]);
    expect(unavailableSlots(project, ASSETS, { s4: 'key' }, all)).toEqual([
      { slotId: 's2', index: 1, reason: 'proxy' },
      { slotId: 's4', index: 3, reason: 'metrics' },
    ]);
    // Превью ещё строится (pending): признаки будут.
    expect(unavailableSlots(project, ASSETS, {}, ['s5'])).toEqual([]);
    // Только из кандидатов и в порядке сетки, а не кандидатов.
    expect(unavailableSlots(project, ASSETS, { s4: 'key' }, ['s4', 's1'])).toEqual([{ slotId: 's4', index: 3, reason: 'metrics' }]);
    // Без статусов ассетов — только неудачи воркера.
    expect(unavailableSlots(project, undefined, { s1: 'key' }, all)).toEqual([{ slotId: 's1', index: 0, reason: 'metrics' }]);
  });

  test('текст: число плиток, позиции с единицы и причина', () => {
    const slot = (index: number, reason: NoDataSlot['reason']): NoDataSlot => ({ slotId: `s${index}`, index, reason });
    expect(noDataText([])).toBe('');
    expect(noDataText([slot(1, 'proxy')])).toBe(
      'Нет данных для 1 плитки (позиция 2): превью не построено — оригинал пропал или изменился.',
    );
    expect(noDataText([slot(0, 'metrics'), slot(2, 'metrics')])).toBe('Нет данных для 2 плиток (позиции 1, 3): превью не читается.');
    expect(noDataText([slot(0, 'proxy'), slot(1, 'proxy'), slot(4, 'metrics')])).toBe(
      'Нет данных для 3 плиток (позиции 1, 2, 5): у позиций 1, 2 превью не построено — оригинал пропал или изменился, ' +
        'у позиции 5 превью не читается.',
    );
    const many = Array.from({ length: 5 }, (_, i) => slot(i, 'proxy'));
    expect(noDataText(many)).toMatch(/^Нет данных для 5 плиток \(позиции 1, 2, 3, 4, 5\)/);
    const twentyOne = Array.from({ length: 21 }, (_, i) => slot(i, 'metrics'));
    // Число плиток склоняется по числу, список позиций — нет: 21 позиция — всё равно «позиции».
    expect(noDataText(twentyOne)).toMatch(/^Нет данных для 21 плитки \(позиции 1, 2, .*, 21\): превью не читается\.$/);
  });
});
