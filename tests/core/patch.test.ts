import { enablePatches, produceWithPatches } from 'immer';
import { describe, expect, test } from 'vitest';
import { createAdjust, createProject, createSlot } from '@core/project/defaults';
import { assignLook, createLook, removeLook } from '@core/project/looks';
import { moveSlots } from '@core/project/order';
import { applyProjectPatches, PatchError, type ProjectPatch } from '@core/project/patch';
import type { Project } from '@core/project/types';
import { CURVE_MAX_POINTS } from '@core/project/validate';

enablePatches();

function sampleProject(): Project {
  const project = createProject('p');
  project.assets['aaaaaaaaaaaaaaaa'] = {
    id: 'aaaaaaaaaaaaaaaa',
    path: '/ph/a.jpg',
    hash: 'a'.repeat(64),
    w: 3000,
    h: 4000,
    format: 'jpeg',
    icc: 'embedded',
    importedAt: '2026-10-07T00:00:00.000Z',
  };
  project.slots.push(createSlot('s1', 'aaaaaaaaaaaaaaaa'), createSlot('s2'));
  return project;
}

/** Проект с тремя слотами и образом, который назначен первому. */
function projectWithLook(): Project {
  const project = sampleProject();
  project.slots.push(createSlot('s3'));
  project.looks.push(createLook('look-1', 'Тёплый'));
  project.slots[0]!.lookId = 'look-1';
  return project;
}

const LUT_ID = '0123456789abcdef';

/** Как projectWithLook, но у образа — импортированный LUT из реестра. */
function projectWithLut(): Project {
  const project = projectWithLook();
  project.luts[LUT_ID] = { id: LUT_ID, name: 'сепия.cube', size: 17, hash: LUT_ID.padEnd(64, '0'), importedAt: '2026-10-08T00:00:00.000Z' };
  project.looks[0]!.importedLut = LUT_ID;
  return project;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Правка через Immer, как в renderer, и те же патчи в main: результат обязан совпасть. */
function roundTrip(base: Project, recipe: (draft: Project) => void): Project {
  const [next, patches] = produceWithPatches(base, recipe);
  const target = clone(base);
  applyProjectPatches(target, patches as ProjectPatch[]);
  expect(target).toEqual(next);
  return target;
}

/** Пакет отвергается и не меняет проект. */
function expectRejected(project: Project, patches: ProjectPatch[]): void {
  const before = clone(project);
  expect(() => applyProjectPatches(project, patches)).toThrow(PatchError);
  expect(project).toEqual(before);
}

describe('патчи проекта из renderer', () => {
  test('патчи Immer применяются на месте и дают тот же проект', () => {
    roundTrip(sampleProject(), (draft) => {
      const slot = draft.slots[0];
      if (!slot) return;
      slot.adjust.exposure = 0.75;
      slot.adjust.temp = -20;
      slot.adjust.hsl.orange.sat = 15;
      slot.adjust.curves.master.splice(1, 0, [0.5, 0.6]);
      slot.crop.grid.cy = 0.3;
    });
  });

  test('замена всей коррекции слота', () => {
    const project = sampleProject();
    const adjust = { ...createAdjust(), contrast: 40 };
    applyProjectPatches(project, [{ op: 'replace', path: ['slots', 1, 'adjust'], value: adjust }]);
    expect(project.slots[1]?.adjust).toEqual(adjust);
  });

  test.each([
    [['name'], 'x'],
    [['assets', 'aaaaaaaaaaaaaaaa', 'path'], '/etc/passwd'],
    [['slots', 0, 'assetId'], 'bbbbbbbbbbbbbbbb'],
    [['slots', 0, 'state'], 'published'],
    [['slots', 0], {}],
    [['slots', 5, 'adjust', 'exposure'], 1],
    [['slots', '0', 'adjust', 'exposure'], 1],
    [['grid', 'columns'], 4],
    [['looks'], {}],
  ] as const)('путь %j запрещён', (path, value) => {
    expectRejected(sampleProject(), [{ op: 'replace', path: [...path], value }]);
  });

  test.each([
    ['exposure', 4],
    ['exposure', Number.NaN],
    ['temp', 101],
    ['contrast', '10'],
    ['saturation', null],
  ] as const)('значение %s = %j вне допустимого — отказ', (field, value) => {
    expectRejected(sampleProject(), [{ op: 'replace', path: ['slots', 0, 'adjust', field], value }]);
  });

  test('некорректная кривая и кадр отвергаются', () => {
    const project = sampleProject();
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'adjust', 'curves', 'r'], value: [[0, 0]] }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'crop', 'feed', 'zoom'], value: 0.5 }]);
    expectRejected(project, [{ op: 'remove', path: ['slots', 0, 'adjust', 'hsl', 'red'] }]);
  });

  test('кривая: x строго растёт, не больше 16 точек', () => {
    const project = sampleProject();
    const path = ['slots', 0, 'adjust', 'curves', 'master'];
    const ok: [number, number][] = Array.from({ length: CURVE_MAX_POINTS }, (_, i) => [i / (CURVE_MAX_POINTS - 1), i / (CURVE_MAX_POINTS - 1)]);
    applyProjectPatches(project, [{ op: 'replace', path, value: ok }]);
    expect(project.slots[0]?.adjust.curves.master).toEqual(ok);
    const tooMany = [...ok.slice(0, 8), [0.5, 0.5], ...ok.slice(8)].sort((p, q) => p[0]! - q[0]!);
    expectRejected(project, [{ op: 'replace', path, value: tooMany }]);
    for (const bad of [
      [
        [0, 0],
        [0.5, 0.4],
        [0.5, 0.6],
        [1, 1],
      ],
      [
        [0, 0],
        [0.7, 0.4],
        [0.3, 0.6],
        [1, 1],
      ],
      [
        [0, 0],
        [0.5, 1.2],
        [1, 1],
      ],
    ]) {
      expectRejected(project, [{ op: 'replace', path, value: bad }]);
    }
  });

  test('путь через __proto__ не загрязняет прототип', () => {
    const project = sampleProject();
    for (const path of [
      ['slots', 0, 'adjust', '__proto__', 'polluted'],
      ['slots', 0, 'adjust', 'constructor', 'prototype', 'polluted'],
      ['slots', 0, 'adjust', 'nope', 'polluted'],
      ['looks', '__proto__', 'polluted'],
    ]) {
      expectRejected(project, [{ op: 'replace', path, value: 1 }]);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('лишние поля в коррекции и кадре отвергаются', () => {
    const project = sampleProject();
    expectRejected(project, [{ op: 'add', path: ['slots', 0, 'adjust', 'extra'], value: 1 }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'crop'], value: { ...project.slots[0]?.crop, x: 1 } }]);
  });

  test('пакет атомарен: при ошибке в одном патче не применяется ни один', () => {
    expectRejected(sampleProject(), [
      { op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 },
      { op: 'replace', path: ['slots', 1, 'adjust', 'tint'], value: 30 },
      { op: 'replace', path: ['slots', 1, 'adjust', 'exposure'], value: 9 },
    ]);
  });

  test('старое значение вне пределов не мешает править другие поля', () => {
    const project = sampleProject();
    project.slots[1]!.adjust.exposure = 7;
    applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 }]);
    expect(project.slots[0]?.adjust.exposure).toBe(1);
  });
});

describe('инварианты: перестановка', () => {
  const ids = (project: Project) => project.slots.map((s) => s.id);

  test('перестановка по индексам проходит', () => {
    const base = projectWithLook();
    const result = roundTrip(base, (draft) => {
      const order = moveSlots(base.slots, ['s1'], 2);
      order.forEach((slot, i) => {
        if (slot !== base.slots[i]) draft.slots[i] = slot;
      });
    });
    expect(ids(result)).toEqual(['s2', 's3', 's1']);
    expect(result.slots[2]?.lookId).toBe('look-1');
  });

  test('замена массива слотов целиком тоже проходит, если состав тот же', () => {
    const base = projectWithLook();
    const result = roundTrip(base, (draft) => {
      draft.slots = [...base.slots].reverse();
    });
    expect(ids(result)).toEqual(['s3', 's2', 's1']);
  });

  test('подмена ассета целым слотом отвергается', () => {
    const project = projectWithLook();
    const forged = { ...clone(project.slots[1]!), assetId: 'aaaaaaaaaaaaaaaa', state: 'planned' };
    expectRejected(project, [{ op: 'replace', path: ['slots', 1], value: forged }]);
  });

  test('слот с прежним id, но лишним полем, отвергается', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'replace', path: ['slots', 1], value: { ...clone(project.slots[1]!), extra: 1 } }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 1, 'target'], value: undefined }]);
  });

  test('добавление, удаление и повтор слота отвергаются', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'add', path: ['slots', 3], value: createSlot('s4') }]);
    expectRejected(project, [{ op: 'remove', path: ['slots', 2] }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 'length'], value: 2 }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 2], value: clone(project.slots[0]) }]);
    expectRejected(project, [{ op: 'replace', path: ['slots'], value: [] }]);
  });
});

describe('инварианты: образы', () => {
  test('создание образа и назначение плиткам проходят', () => {
    const result = roundTrip(sampleProject(), (draft) => {
      draft.looks.push(createLook('look-2', 'Холодный'));
      assignLook(draft, ['s1', 's2'], 'look-2');
    });
    expect(result.slots.map((s) => s.lookId)).toEqual(['look-2', 'look-2']);
  });

  test('удаление образа вместе со ссылками проходит', () => {
    const base = projectWithLook();
    base.looks.unshift(createLook('look-0', 'Первый'));
    const result = roundTrip(base, (draft) => removeLook(draft, 'look-1'));
    expect(result.looks.map((l) => l.id)).toEqual(['look-0']);
    expect('lookId' in result.slots[0]!).toBe(false);
  });

  test('удаление образа со ссылками отвергается', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'remove', path: ['looks', 0] }]);
    expectRejected(project, [{ op: 'replace', path: ['looks', 'length'], value: 0 }]);
  });

  test('ссылка на несуществующий образ отвергается', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'lookId'], value: 'nope' }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 1, 'lookId'], value: 42 }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 1, 'lookId'], value: undefined }]);
  });

  test('повтор id образа отвергается', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'add', path: ['looks', 1], value: createLook('look-1', 'Копия') }]);
  });

  test.each([
    ['пустое имя', createLook('l', '')],
    ['имя из пробелов', createLook('l', '   ')],
    ['длинное имя', createLook('l', 'x'.repeat(101))],
    ['пустой id', createLook('', 'Образ')],
    ['лишнее поле', { ...createLook('l', 'Образ'), extra: 1 }],
    ['коррекция вне пределов', { ...createLook('l', 'Образ'), adjust: { ...createAdjust(), exposure: 5 } }],
    ['LUT не из реестра', { ...createLook('l', 'Образ'), importedLut: 'ffffffffffffffff' }],
    ['LUT не строкой', { ...createLook('l', 'Образ'), importedLut: 17 }],
  ])('некорректный образ: %s', (_, look) => {
    expectRejected(sampleProject(), [{ op: 'add', path: ['looks', 0], value: look }]);
  });

  test('LUT образа: снять и вернуть можно только LUT из реестра; сам реестр меняет только main (ADR 0015)', () => {
    const project = projectWithLut();
    // «Снять LUT» и отмена — обычные правки renderer.
    const detached = roundTrip(project, (draft) => {
      delete draft.looks[0]!.importedLut;
    });
    expect(detached.looks[0]).not.toHaveProperty('importedLut');
    const back = roundTrip(detached, (draft) => {
      draft.looks[0]!.importedLut = LUT_ID;
    });
    expect(back.looks[0]?.importedLut).toBe(LUT_ID);
    // Неизвестный id и не строка отвергаются, остальное в образе с LUT править можно.
    expectRejected(project, [{ op: 'replace', path: ['looks', 0, 'importedLut'], value: 'ffffffffffffffff' }]);
    expectRejected(project, [{ op: 'replace', path: ['looks', 0, 'importedLut'], value: '/luts/other.cube' }]);
    expectRejected(project, [{ op: 'replace', path: ['luts'], value: {} }]);
    expectRejected(project, [{ op: 'add', path: ['luts', 'ffffffffffffffff'], value: { id: 'ffffffffffffffff' } }]);
    applyProjectPatches(project, [
      { op: 'replace', path: ['looks', 0, 'name'], value: 'Плёнка' },
      { op: 'replace', path: ['looks', 0, 'adjust', 'exposure'], value: 0.5 },
    ]);
    expect(project.looks[0]).toMatchObject({ name: 'Плёнка', importedLut: LUT_ID, adjust: { exposure: 0.5 } });
  });

  test('удаление образа с LUT отменяется обратными патчами, вместе с LUT и плитками', () => {
    const project = projectWithLut();
    const [removed, patches, inverse] = produceWithPatches(project, (draft) => removeLook(draft, 'look-1'));
    const target = clone(project);
    applyProjectPatches(target, patches as ProjectPatch[]);
    expect(target).toEqual(removed);
    applyProjectPatches(target, inverse as ProjectPatch[]);
    expect(target).toEqual(project);
    expect(target.looks[0]?.importedLut).toBe(LUT_ID);
    expect(target.slots[0]?.lookId).toBe('look-1');
  });
});
