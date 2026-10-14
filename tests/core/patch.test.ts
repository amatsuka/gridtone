import { enablePatches, original, produceWithPatches } from 'immer';
import { describe, expect, test } from 'vitest';
import { createAdjust, createProject, createSlot } from '@core/project/defaults';
import { assignLook, createLook, removeLook } from '@core/project/looks';
import { moveSlots } from '@core/project/order';
import { applyProjectPatches, PatchError, type ProjectPatch } from '@core/project/patch';
import { assignSlots, insertEmptySlots, removeEmptySlots, setPublished } from '@core/project/slots';
import type { Pattern, Project, Slot } from '@core/project/types';
import { DEFAULT_LEVELS } from '@core/pattern/levels';
import { clearTargets, targetAt, withPatternTargets } from '@core/pattern/pattern';
import { stringPattern } from '@core/pattern/string';
import { CURVE_MAX_POINTS, SLOT_ID_MAX } from '@core/project/validate';

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
    applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust'], value: adjust }]);
    expect(project.slots[0]?.adjust).toEqual(adjust);
  });

  test.each([
    [['name'], 'x'],
    [['assets', 'aaaaaaaaaaaaaaaa', 'path'], '/etc/passwd'],
    [['slots', 0, 'assetId'], 'bbbbbbbbbbbbbbbb'],
    [['slots', 1, 'state'], 'published'],
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
      const order = moveSlots(base.slots, ['s1'], 2, 0);
      order.forEach((slot, i) => {
        if (slot !== base.slots[i]) draft.slots[i] = slot;
      });
    });
    // s3 — пустая позиция: одна плитка на ней меняется с ней местами (ADR 0022).
    expect(ids(result)).toEqual(['s3', 's2', 's1']);
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

  test('добавление фото, удаление фото и повтор слота отвергаются', () => {
    const project = projectWithLook();
    expectRejected(project, [{ op: 'add', path: ['slots', 3], value: createSlot('s4', 'aaaaaaaaaaaaaaaa') }]);
    expectRejected(project, [{ op: 'remove', path: ['slots', 0] }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 2], value: clone(project.slots[0]) }]);
    expectRejected(project, [{ op: 'replace', path: ['slots'], value: [] }]);
    expectRejected(project, [{ op: 'replace', path: ['slots'], value: {} }]);
  });
});

describe('инварианты: образы', () => {
  test('создание образа и назначение плиткам проходят', () => {
    const result = roundTrip(sampleProject(), (draft) => {
      draft.looks.push(createLook('look-2', 'Холодный'));
      assignLook(draft, ['s1', 's2'], 'look-2');
    });
    // s2 — пустая позиция: образа у неё нет (ADR 0022).
    expect(result.slots.map((s) => s.lookId)).toEqual(['look-2', undefined]);
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

describe('инварианты: статусы, пустые позиции и закреплённые (ADR 0022)', () => {
  const A = 'aaaaaaaaaaaaaaaa';
  /** Три фото и пустая позиция в конце. */
  function grid(): Project {
    const project = sampleProject();
    project.slots = [createSlot('p1', A), createSlot('p2', A), createSlot('p3', A), createSlot('e1')];
    project.looks.push(createLook('look-1', 'Тёплый'), createLook('look-2', 'Холодный'));
    return project;
  }
  const ids = (project: Project) => project.slots.map((s) => s.id);

  test('статус «запланирован» ↔ «опубликован» — только у позиции с фото', () => {
    const published = roundTrip(grid(), (draft) => setPublished(draft, ['p2', 'p3', 'e1'], true));
    expect(published.slots.map((s) => s.state)).toEqual(['planned', 'published', 'published', 'empty']);
    const back = roundTrip(published, (draft) => setPublished(draft, ['p2'], false));
    expect(back.slots[1]?.state).toBe('planned');
    const project = grid();
    expectRejected(project, [{ op: 'replace', path: ['slots', 3, 'state'], value: 'published' }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 3, 'state'], value: 'planned' }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'state'], value: 'empty' }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 0, 'state'], value: 'draft' }]);
  });

  test('у опубликованного коррекция и кадр не меняются, в том числе в одном пакете со статусом', () => {
    const project = grid();
    project.slots[1]!.state = 'published';
    expectRejected(project, [{ op: 'replace', path: ['slots', 1, 'adjust', 'exposure'], value: 1 }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 1, 'crop', 'grid', 'cy'], value: 0.4 }]);
    expectRejected(project, [
      { op: 'replace', path: ['slots', 1, 'state'], value: 'planned' },
      { op: 'replace', path: ['slots', 1, 'adjust', 'exposure'], value: 1 },
    ]);
    expectRejected(project, [
      { op: 'replace', path: ['slots', 0, 'state'], value: 'published' },
      { op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 },
    ]);
    // Перестановка опубликованного целым слотом — не правка: кадр и коррекция те же.
    roundTrip(project, (draft) => {
      const [a, b] = [draft.slots[0]!, draft.slots[1]!];
      draft.slots[0] = b;
      draft.slots[1] = a;
    });
    applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 }]);
    expect(project.slots[0]?.adjust.exposure).toBe(1);
  });

  test('образ опубликованного не назначается и не снимается, но уходит вместе с удалением образа и возвращается отменой', () => {
    const project = grid();
    project.slots[1]!.lookId = 'look-1';
    project.slots[1]!.state = 'published';
    expectRejected(project, [{ op: 'replace', path: ['slots', 1, 'lookId'], value: 'look-2' }]);
    expectRejected(project, [{ op: 'remove', path: ['slots', 1, 'lookId'] }]);
    project.slots[2]!.state = 'published';
    expectRejected(project, [{ op: 'add', path: ['slots', 2, 'lookId'], value: 'look-2' }]);

    const [removed, patches, inverse] = produceWithPatches(project, (draft) => removeLook(draft, 'look-1'));
    const target = clone(project);
    applyProjectPatches(target, patches as ProjectPatch[]);
    expect(target).toEqual(removed);
    expect('lookId' in target.slots[1]!).toBe(false);
    applyProjectPatches(target, inverse as ProjectPatch[]);
    expect(target).toEqual(project);
  });

  test('новый слот — только пустая позиция со значениями по умолчанию', () => {
    const base = grid();
    const result = roundTrip(base, (draft) => assignSlots(draft.slots, base.slots, insertEmptySlots(base.slots, ['n1', 'n2'], 1)));
    expect(ids(result)).toEqual(['p1', 'n1', 'n2', 'p2', 'p3', 'e1']);
    expect(result.slots[1]).toEqual(createSlot('n1'));

    const at = (value: unknown): ProjectPatch[] => [{ op: 'add', path: ['slots', 4], value }];
    const empty = createSlot('n');
    for (const value of [
      createSlot('n', A),
      { ...empty, state: 'planned' },
      { ...empty, adjust: { ...createAdjust(), exposure: 1 } },
      { ...empty, crop: { ...empty.crop, grid: { cx: 0.4, cy: 0.5 } } },
      { ...empty, lookId: 'look-1' },
      { ...empty, choiceLocked: true },
      { ...empty, postType: 'reels' },
      { ...empty, candidates: [{ assetId: A, score: 1, parts: { L: 0, hue: 0, chroma: 0, palette: 0, penalty: 0 } }] },
      { ...empty, extra: 1 },
      createSlot(''),
      createSlot('x'.repeat(SLOT_ID_MAX + 1)),
      createSlot('p1'),
      { ...empty, id: 7 },
      null,
    ]) {
      expectRejected(grid(), at(value));
    }
  });

  test('удалить можно только пустую позицию; фото в позицию не поставить и из неё не убрать', () => {
    const base = grid();
    const removed = roundTrip(base, (draft) => assignSlots(draft.slots, base.slots, removeEmptySlots(base.slots, ['e1', 'p1'])));
    expect(ids(removed)).toEqual(['p1', 'p2', 'p3']);
    applyProjectPatches(grid(), [{ op: 'replace', path: ['slots', 'length'], value: 3 }]);
    expectRejected(grid(), [{ op: 'remove', path: ['slots', 0] }]);
    expectRejected(grid(), [{ op: 'replace', path: ['slots', 'length'], value: 2 }]);
    expectRejected(grid(), [{ op: 'add', path: ['slots', 3, 'assetId'], value: A }]);
    expectRejected(grid(), [{ op: 'remove', path: ['slots', 0, 'assetId'] }]);
    // Фото «переезжает» в пустую позицию только перестановкой слотов целиком.
    const swapped = roundTrip(base, (draft) => {
      const [photo, empty] = [draft.slots[0]!, draft.slots[3]!];
      draft.slots[0] = empty;
      draft.slots[3] = photo;
    });
    expect(ids(swapped)).toEqual(['e1', 'p2', 'p3', 'p1']);
  });

  test('у пустой позиции коррекция, кадр и образ не меняются', () => {
    const project = grid();
    expectRejected(project, [{ op: 'replace', path: ['slots', 3, 'adjust', 'exposure'], value: 1 }]);
    expectRejected(project, [{ op: 'replace', path: ['slots', 3, 'crop', 'grid', 'cx'], value: 0.4 }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 3, 'lookId'], value: 'look-1' }]);
  });

  test('корень grid — только pinned 0–3', () => {
    const pinned = roundTrip(grid(), (draft) => {
      draft.grid.pinned = 2;
    });
    expect(pinned.grid).toEqual({ ratio: '3:4', columns: 3, pinned: 2 });
    roundTrip(pinned, (draft) => {
      draft.grid.pinned = 0;
    });
    for (const value of [4, -1, 1.5, '1', null]) expectRejected(grid(), [{ op: 'replace', path: ['grid', 'pinned'], value }]);
    expectRejected(grid(), [{ op: 'replace', path: ['grid', 'ratio'], value: '1:1' }]);
    expectRejected(grid(), [{ op: 'replace', path: ['grid', 'columns'], value: 4 }]);
    expectRejected(grid(), [{ op: 'add', path: ['grid', 'extra'], value: 1 }]);
    expectRejected(grid(), [{ op: 'remove', path: ['grid', 'pinned'] }]);
    expectRejected(grid(), [{ op: 'replace', path: ['grid'], value: { ratio: '3:4', columns: 3, pinned: 1, extra: 1 } }]);
    expectRejected(grid(), [{ op: 'replace', path: ['grid', '__proto__', 'pinned'], value: 1 }]);
  });
});

describe('инварианты: паттерн и цели позиций (ADR 0023)', () => {
  const A = 'aaaaaaaaaaaaaaaa';
  const checker = () => stringPattern('LDL/DLD', DEFAULT_LEVELS);
  const pattern = (): Pattern => {
    const result = checker();
    if (!result.ok) throw new Error(result.error);
    return result.pattern;
  };
  /** Четыре фото и пустая позиция, без паттерна. */
  function grid(pinned: Project['grid']['pinned'] = 0): Project {
    const project = sampleProject();
    project.slots = [createSlot('p1', A), createSlot('p2', A), createSlot('p3', A), createSlot('p4', A), createSlot('e1')];
    project.grid.pinned = pinned;
    return project;
  }
  /** То же с паттерном LDL/DLD и согласованными целями. */
  function withPattern(pinned: Project['grid']['pinned'] = 0): Project {
    const project = grid(pinned);
    project.pattern = pattern();
    project.slots = withPatternTargets(project.slots, project.pattern, pinned);
    return project;
  }
  const apply = (draft: Project, p: Pattern | undefined) => {
    const base = original(draft.slots) as Slot[];
    if (p) draft.pattern = p;
    else delete draft.pattern;
    assignSlots(draft.slots, base, p ? withPatternTargets(base, p, draft.grid.pinned) : clearTargets(base));
  };

  test('«Применить к сетке» — паттерн и цели всех позиций одним пакетом; отмена и «Убрать цели»', () => {
    const base = grid(1);
    const [applied, patches, inverse] = produceWithPatches(base, (draft) => apply(draft, pattern()));
    const main = clone(base);
    applyProjectPatches(main, patches as ProjectPatch[]);
    expect(main).toEqual(applied);
    expect(main.pattern).toEqual(pattern());
    expect(main.slots.map((s) => s.target?.L ?? null)).toEqual([null, 0.44, 0.8, 0.44, 0.8]);
    applyProjectPatches(main, inverse as ProjectPatch[]);
    expect(main).toEqual(base);
    expect('pattern' in main).toBe(false);
    const cleared = roundTrip(applied, (draft) => apply(draft, undefined));
    expect('pattern' in cleared).toBe(false);
    expect(cleared.slots.some((s) => 'target' in s)).toBe(false);
  });

  test('цели должны быть согласованы с паттерном: ни лишних, ни пропущенных, ни чужих', () => {
    expectRejected(grid(), [{ op: 'add', path: ['pattern'], value: pattern() }]);
    const project = withPattern(1);
    expectRejected(project, [{ op: 'replace', path: ['slots', 1, 'target', 'L'], value: 0.5 }]);
    expectRejected(project, [{ op: 'remove', path: ['slots', 2, 'target'] }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 0, 'target'], value: pattern().cells[0] }]);
    // Перестановка без пересчёта целей: цель уехала вместе с фото.
    expectRejected(project, [
      { op: 'replace', path: ['slots', 1], value: project.slots[2] },
      { op: 'replace', path: ['slots', 2], value: project.slots[1] },
    ]);
    // Смена закреплённых без пересчёта.
    expectRejected(project, [{ op: 'replace', path: ['grid', 'pinned'], value: 0 }]);
    // Смена паттерна без пересчёта.
    expectRejected(project, [{ op: 'replace', path: ['pattern', 'cells', 1, 'L'], value: 0.3 }]);
  });

  test('перестановка, пустые позиции и закреплённые с пересчётом целей проходят', () => {
    const base = withPattern(1);
    const moved = roundTrip(base, (draft) =>
      assignSlots(draft.slots, base.slots, withPatternTargets(moveSlots(base.slots, ['p2'], 3, 1), base.pattern, 1, base.slots)),
    );
    expect(moved.slots.map((s) => s.id)).toEqual(['p1', 'p3', 'p4', 'p2', 'e1']);
    const inserted = roundTrip(base, (draft) =>
      assignSlots(draft.slots, base.slots, withPatternTargets(insertEmptySlots(base.slots, ['n1', 'n2'], 1), base.pattern, 1, base.slots)),
    );
    expect(inserted.slots[1]).toEqual({ ...createSlot('n1'), target: targetAt(base.pattern!, 1, 1) });
    roundTrip(inserted, (draft) =>
      assignSlots(draft.slots, inserted.slots, withPatternTargets(removeEmptySlots(inserted.slots, ['n1', 'e1']), base.pattern, 1, inserted.slots)),
    );
    roundTrip(base, (draft) => {
      draft.grid.pinned = 3;
      assignSlots(draft.slots, base.slots, withPatternTargets(base.slots, base.pattern, 3, base.slots));
    });
  });

  test('новый слот — пустая позиция по умолчанию, кроме цели своей позиции', () => {
    const project = withPattern();
    const target = targetAt(project.pattern!, 5, 0);
    applyProjectPatches(clone(project), [{ op: 'add', path: ['slots', 5], value: { ...createSlot('n'), target } }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 5], value: { ...createSlot('n'), target: targetAt(project.pattern!, 4, 0) } }]);
    expectRejected(project, [{ op: 'add', path: ['slots', 5], value: createSlot('n') }]);
    // Без паттерна — цель любой корректной формы (renderer переносит цели позиций).
    applyProjectPatches(grid(), [{ op: 'add', path: ['slots', 5], value: { ...createSlot('n'), target } }]);
    expectRejected(grid(), [{ op: 'add', path: ['slots', 5], value: { ...createSlot('n'), target: { ...target, L: 2 } } }]);
  });

  test('форма паттерна: источник, период, клетки, режим публикации — вычисленный', () => {
    const p = pattern();
    const bad: unknown[] = [
      { ...p, postingMode: 'batch' },
      { ...p, periodRows: 3 },
      { ...p, periodRows: 0, cells: [] },
      { ...p, source: 'magic' },
      { ...p, extra: 1 },
      { ...p, cells: [...p.cells.slice(0, 5), { ...p.cells[5], L: -0.1 }] },
      { ...p, cells: [...p.cells.slice(0, 5), { ...p.cells[5], hard: 'yes' }] },
      { ...p, cells: [...p.cells.slice(0, 5), { ...p.cells[5], tolerance: { L: 0.06 } }] },
      null,
      [],
    ];
    // Цели согласованы с клетками p: отказ — из-за формы паттерна, а не из-за целей.
    for (const value of bad) expectRejected(withPattern(), [{ op: 'replace', path: ['pattern'], value }]);
    applyProjectPatches(withPattern(), [{ op: 'replace', path: ['pattern', 'source'], value: 'generator' }]);
    expectRejected(withPattern(), [{ op: 'replace', path: ['pattern', '__proto__', 'source'], value: 'string' }]);
    expectRejected(grid(), [{ op: 'replace', path: ['pattern', 'source'], value: 'string' }]);
  });

  test('форма цели проверяется и без паттерна', () => {
    const target = { L: 0.5, tolerance: { L: 0.06, hue: 15, chroma: 0.02 }, hard: true };
    applyProjectPatches(grid(), [{ op: 'add', path: ['slots', 0, 'target'], value: target }]);
    applyProjectPatches(grid(), [{ op: 'add', path: ['slots', 4, 'target'], value: { ...target, hue: 120, chroma: 0.05 } }]);
    for (const value of [
      { ...target, L: 1.5 },
      { ...target, hue: 360 },
      { ...target, chroma: -0.01 },
      { ...target, extra: 1 },
      { ...target, tolerance: { L: 0.06, hue: 15 } },
      { ...target, tolerance: { L: -1, hue: 15, chroma: 0.02 } },
      { L: 0.5, hard: true },
      'L',
    ]) {
      expectRejected(grid(), [{ op: 'add', path: ['slots', 0, 'target'], value }]);
    }
  });

  test('цель опубликованной и пустой позиции — тоже цель позиции: меняется вместе с паттерном', () => {
    const base = grid();
    base.slots[1]!.state = 'published';
    const applied = roundTrip(base, (draft) => apply(draft, pattern()));
    expect(applied.slots[1]?.target?.L).toBe(0.44);
    expect(applied.slots[4]?.target?.L).toBe(0.8);
  });

  test('старые несогласованные цели не мешают правкам, которые цели не трогают', () => {
    const project = withPattern();
    project.slots[0]!.target = { ...project.slots[0]!.target!, L: 0.1 };
    applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 }]);
    expect(project.slots[0]?.adjust.exposure).toBe(1);
  });
});
