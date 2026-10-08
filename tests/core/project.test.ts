import { describe, expect, test } from 'vitest';
import { HUE_BANDS, createAdjust, createProject, createSlot } from '@core/project/defaults';
import { ProjectFormatError, parseProject, serializeProject } from '@core/project/serialize';
import type { Project } from '@core/project/types';

function sampleProject(): Project {
  const project = createProject('Весна');
  project.grid.pinned = 2;
  project.assets['0123456789abcdef'] = {
    id: '0123456789abcdef',
    path: '/Users/me/Photos/IMG_0001.jpg',
    hash: '0123456789abcdef'.padEnd(64, '0'),
    w: 3024,
    h: 4032,
    format: 'jpeg',
    icc: 'embedded',
    importedAt: '2026-10-06T12:00:00.000Z',
  };
  const slot = createSlot('slot-1', '0123456789abcdef');
  slot.adjust.exposure = 0.35;
  slot.adjust.hsl.orange.sat = -12;
  slot.adjust.curves.master = [
    [0, 0.02],
    [0.5, 0.55],
    [1, 1],
  ];
  slot.crop.feed = { aspect: '4:5', cx: 0.48, cy: 0.52, zoom: 1.1, angle: -1.5 };
  slot.lookId = 'look-1';
  slot.target = { L: 0.72, hue: 40, tolerance: { L: 0.05, hue: 15, chroma: 0.03 }, hard: true };
  slot.candidates = [
    { assetId: '0123456789abcdef', score: 0.9, parts: { L: 0.1, hue: 0.2, chroma: 0.3, palette: 0.4, penalty: 0 } },
  ];
  project.slots.push(slot, createSlot('slot-2'));
  project.looks.push({ id: 'look-1', name: 'Тёплый', adjust: createAdjust() });
  project.luts['fedcba9876543210'] = {
    id: 'fedcba9876543210',
    name: 'сепия.cube',
    size: 17,
    hash: 'fedcba9876543210'.padEnd(64, '1'),
    importedAt: '2026-10-08T12:00:00.000Z',
  };
  project.looks.push({ id: 'look-2', name: 'Сепия', adjust: createAdjust(), importedLut: 'fedcba9876543210' });
  project.pattern = { source: 'generator', periodRows: 2, postingMode: 'batch', cells: [] };
  return project;
}

describe('значения по умолчанию', () => {
  test('нейтральная коррекция покрывает все 8 диапазонов HSL и тождественные кривые', () => {
    const adjust = createAdjust();
    expect(Object.keys(adjust.hsl).sort()).toEqual([...HUE_BANDS].sort());
    for (const curve of Object.values(adjust.curves)) {
      expect(curve).toEqual([
        [0, 0],
        [1, 1],
      ]);
    }
  });

  test('пустой слот не содержит ключа assetId', () => {
    const slot = createSlot('s');
    expect(slot.state).toBe('empty');
    expect('assetId' in slot).toBe(false);
    expect(createSlot('s', 'a').state).toBe('planned');
  });
});

describe('project.json', () => {
  test('круговой проход без потерь', () => {
    const project = sampleProject();
    const text = serializeProject(project);
    const parsed = parseProject(text);
    expect(parsed).toStrictEqual(project);
    expect(serializeProject(parsed)).toBe(text);
  });

  test.each([
    ['не JSON', '{oops'],
    ['чужая версия', JSON.stringify({ ...sampleProject(), version: 2 })],
    ['нет ассетов', JSON.stringify({ ...sampleProject(), assets: undefined })],
  ])('отклоняет: %s', (_, text) => {
    expect(() => parseProject(text)).toThrow(ProjectFormatError);
  });

  test('отклоняет слот со ссылкой на неизвестный ассет', () => {
    const project = sampleProject();
    project.slots.push(createSlot('slot-3', 'ffffffffffffffff'));
    expect(() => parseProject(serializeProject(project))).toThrow(/неизвестный ассет/);
  });

  test('отклоняет повторяющиеся id слотов', () => {
    const project = sampleProject();
    project.slots.push(createSlot('slot-1'));
    expect(() => parseProject(serializeProject(project))).toThrow(/повторяется слот/);
  });

  test('отклоняет слот со ссылкой на неизвестный образ', () => {
    const project = sampleProject();
    project.looks = [];
    expect(() => parseProject(serializeProject(project))).toThrow(/неизвестный образ/);
  });

  test('отклоняет повторяющиеся и неполные образы', () => {
    const project = sampleProject();
    project.looks.push({ id: 'look-1', name: 'Копия', adjust: createAdjust() });
    expect(() => parseProject(serializeProject(project))).toThrow(/повторяется образ/);

    const unnamed = JSON.parse(serializeProject(sampleProject())) as { looks: Record<string, unknown>[] };
    delete unnamed.looks[0]?.['name'];
    expect(() => parseProject(JSON.stringify(unnamed))).toThrow(/некорректный образ/);
  });

  test('проект без реестра LUT (до этапа 3б) открывается с пустым реестром', () => {
    const old = JSON.parse(serializeProject(sampleProject())) as Record<string, unknown> & { looks: Record<string, unknown>[] };
    delete old['luts'];
    old.looks = old.looks.filter((look) => look['importedLut'] === undefined);
    const parsed = parseProject(JSON.stringify(old));
    expect(parsed.luts).toEqual({});
    expect(createProject('новый').luts).toEqual({});
  });

  test('отклоняет образ со ссылкой на LUT не из реестра', () => {
    const project = sampleProject();
    project.luts = {};
    expect(() => parseProject(serializeProject(project))).toThrow(/неизвестный LUT/);
    const notString = JSON.parse(serializeProject(sampleProject())) as { looks: Record<string, unknown>[] };
    notString.looks[1]!['importedLut'] = 17;
    expect(() => parseProject(JSON.stringify(notString))).toThrow(/неизвестный LUT/);
  });

  test.each([
    ['ключ не совпадает с id', { id: '0000000000000000' }],
    ['id не из 16 hex', { id: 'Сепия' }],
    ['размер вне 2…65', { size: 66 }],
    ['дробный размер', { size: 17.5 }],
    ['нет имени', { name: undefined }],
    ['хэш не из 64 hex', { hash: 'abc' }],
    ['хэш не начинается с id', { hash: '0'.repeat(64) }],
    ['нет даты', { importedAt: undefined }],
  ])('отклоняет запись реестра LUT: %s', (_, patch) => {
    const project = JSON.parse(serializeProject(sampleProject())) as { luts: Record<string, Record<string, unknown>> };
    const ref = project.luts['fedcba9876543210']!;
    Object.assign(ref, patch);
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete ref[key];
    expect(() => parseProject(JSON.stringify(project))).toThrow(/некорректный LUT/);
  });

  test('отклоняет ассет, чей ключ не совпадает с id', () => {
    const project = sampleProject();
    const asset = project.assets['0123456789abcdef'];
    if (!asset) throw new Error('нет ассета');
    project.assets['aaaaaaaaaaaaaaaa'] = asset;
    expect(() => parseProject(serializeProject(project))).toThrow(/некорректный ассет/);
  });
});
