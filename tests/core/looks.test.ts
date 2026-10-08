import { describe, expect, test } from 'vitest';
import { createAdjust, createProject, createSlot } from '@core/project/defaults';
import { assignLook, createLook, duplicateLook, lookUsage, nextLookName, removeLook } from '@core/project/looks';
import type { Project } from '@core/project/types';
import { LOOK_NAME_MAX } from '@core/project/validate';

function sample(): Project {
  const project = createProject('p');
  project.slots.push(createSlot('s1', 'aaaaaaaaaaaaaaaa'), createSlot('s2', 'aaaaaaaaaaaaaaaa'), createSlot('s3'));
  project.looks.push(createLook('warm', 'Тёплый'), createLook('cold', 'Холодный'));
  return project;
}

describe('образы', () => {
  test('новый образ нейтрален или копирует поправку, не деля с ней объекты', () => {
    expect(createLook('l', 'Образ 1')).toEqual({ id: 'l', name: 'Образ 1', adjust: createAdjust() });

    const adjust = { ...createAdjust(), exposure: 0.5 };
    const look = createLook('l', 'Образ 1', adjust);
    expect(look.adjust).toEqual(adjust);
    adjust.hsl.red.hue = 10;
    expect(look.adjust.hsl.red.hue).toBe(0);
  });

  test('имя по умолчанию — наименьший свободный номер', () => {
    expect(nextLookName([])).toBe('Образ 1');
    expect(nextLookName([createLook('a', 'Образ 1'), createLook('b', 'Образ 3')])).toBe('Образ 2');
  });

  test('назначение и снятие; опубликованные посты не перекрашиваются', () => {
    const project = sample();
    project.slots[1]!.state = 'published';
    assignLook(project, ['s1', 's2', 's3'], 'warm');
    expect(project.slots.map((s) => s.lookId)).toEqual(['warm', undefined, 'warm']);
    expect(lookUsage(project, 'warm')).toBe(2);

    assignLook(project, ['s1'], null);
    expect('lookId' in project.slots[0]!).toBe(false);
    expect(project.slots[2]?.lookId).toBe('warm');
  });

  test('несуществующий образ не назначается', () => {
    const project = sample();
    assignLook(project, ['s1'], 'nope');
    expect('lookId' in project.slots[0]!).toBe(false);
  });

  test('удаление снимает образ с плиток', () => {
    const project = sample();
    assignLook(project, ['s1', 's3'], 'warm');
    assignLook(project, ['s2'], 'cold');
    removeLook(project, 'warm');
    expect(project.looks.map((l) => l.id)).toEqual(['cold']);
    expect(project.slots.map((s) => s.lookId)).toEqual([undefined, 'cold', undefined]);
    expect(project.slots.some((s) => 'lookId' in s && s.lookId === undefined)).toBe(false);
  });

  test('копия встаёт после оригинала, с новым id и именем, со ссылкой на тот же LUT', () => {
    const project = sample();
    project.looks[0]!.adjust.exposure = 1;
    project.looks[0]!.importedLut = '0123456789abcdef';
    const copy = duplicateLook(project, 'warm', 'warm-2');
    expect(project.looks.map((l) => l.id)).toEqual(['warm', 'warm-2', 'cold']);
    expect(copy).toEqual({ id: 'warm-2', name: 'Тёплый копия', adjust: { ...createAdjust(), exposure: 1 }, importedLut: '0123456789abcdef' });
    expect(copy?.adjust).not.toBe(project.looks[0]!.adjust);
    // Образ без LUT копируется без поля importedLut.
    expect(duplicateLook(project, 'cold', 'cold-2')).not.toHaveProperty('importedLut');

    duplicateLook(project, 'warm', 'warm-3');
    expect(project.looks[1]?.name).toBe('Тёплый копия 2');
    expect(duplicateLook(project, 'nope', 'x')).toBeUndefined();
  });

  test('имя копии не длиннее предела', () => {
    const project = sample();
    project.looks[0]!.name = 'я'.repeat(LOOK_NAME_MAX);
    const copy = duplicateLook(project, 'warm', 'warm-2');
    expect(copy?.name.length).toBeLessThanOrEqual(LOOK_NAME_MAX);
    expect(copy?.name.endsWith(' копия')).toBe(true);
  });
});
