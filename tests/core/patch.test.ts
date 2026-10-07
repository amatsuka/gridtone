import { enablePatches, produceWithPatches } from 'immer';
import { describe, expect, test } from 'vitest';
import { createAdjust, createProject, createSlot } from '@core/project/defaults';
import { applyProjectPatches, PatchError, type ProjectPatch } from '@core/project/patch';
import type { Project } from '@core/project/types';

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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('патчи проекта из renderer', () => {
  test('патчи Immer применяются на месте и дают тот же проект', () => {
    const base = sampleProject();
    const [next, patches] = produceWithPatches(base, (draft) => {
      const slot = draft.slots[0];
      if (!slot) return;
      slot.adjust.exposure = 0.75;
      slot.adjust.temp = -20;
      slot.adjust.hsl.orange.sat = 15;
      slot.adjust.curves.master.splice(1, 0, [0.5, 0.6]);
      slot.crop.grid.cy = 0.3;
    });
    const target = clone(base);
    applyProjectPatches(target, patches as ProjectPatch[]);
    expect(target).toEqual(next);
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
  ] as const)('путь %j запрещён', (path, value) => {
    const project = sampleProject();
    const before = clone(project);
    expect(() => applyProjectPatches(project, [{ op: 'replace', path: [...path], value }])).toThrow(PatchError);
    expect(project).toEqual(before);
  });

  test.each([
    ['exposure', 4],
    ['exposure', Number.NaN],
    ['temp', 101],
    ['contrast', '10'],
    ['saturation', null],
  ] as const)('значение %s = %j вне допустимого — отказ', (field, value) => {
    const project = sampleProject();
    expect(() => applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust', field], value }])).toThrow(
      PatchError,
    );
    expect(project.slots[0]?.adjust).toEqual(createAdjust());
  });

  test('некорректная кривая и кадр отвергаются', () => {
    const project = sampleProject();
    expect(() =>
      applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'adjust', 'curves', 'r'], value: [[0, 0]] }]),
    ).toThrow(PatchError);
    expect(() =>
      applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'crop', 'feed', 'zoom'], value: 0.5 }]),
    ).toThrow(PatchError);
    expect(() =>
      applyProjectPatches(project, [{ op: 'remove', path: ['slots', 0, 'adjust', 'hsl', 'red'] }]),
    ).toThrow(PatchError);
  });

  test('путь через __proto__ не загрязняет прототип', () => {
    const project = sampleProject();
    for (const path of [
      ['slots', 0, 'adjust', '__proto__', 'polluted'],
      ['slots', 0, 'adjust', 'constructor', 'prototype', 'polluted'],
      ['slots', 0, 'adjust', 'nope', 'polluted'],
    ]) {
      expect(() => applyProjectPatches(project, [{ op: 'replace', path, value: 1 }])).toThrow(PatchError);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('лишние поля в коррекции и кадре отвергаются', () => {
    const project = sampleProject();
    expect(() =>
      applyProjectPatches(project, [{ op: 'add', path: ['slots', 0, 'adjust', 'extra'], value: 1 }]),
    ).toThrow(PatchError);
    expect(() =>
      applyProjectPatches(project, [{ op: 'replace', path: ['slots', 0, 'crop'], value: { ...project.slots[0]?.crop, x: 1 } }]),
    ).toThrow(PatchError);
    expect(project.slots[0]?.adjust).toEqual(createAdjust());
  });

  test('пакет атомарен: при ошибке в одном патче не применяется ни один', () => {
    const project = sampleProject();
    const before = clone(project);
    expect(() =>
      applyProjectPatches(project, [
        { op: 'replace', path: ['slots', 0, 'adjust', 'exposure'], value: 1 },
        { op: 'replace', path: ['slots', 1, 'adjust', 'tint'], value: 30 },
        { op: 'replace', path: ['slots', 1, 'adjust', 'exposure'], value: 9 },
      ]),
    ).toThrow(PatchError);
    expect(project).toEqual(before);
  });
});
