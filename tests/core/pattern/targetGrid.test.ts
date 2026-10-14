// `Цели.png`: плитки 540 px по gridLayout, заливка — цвет цели позиции, без цели — GRID_EMPTY (ADR 0026).
import { describe, expect, test } from 'vitest';
import { DEFAULT_LEVELS, hardTarget, levelL } from '@core/pattern/levels';
import { makePattern, withPatternTargets } from '@core/pattern/pattern';
import { targetSwatch } from '@core/pattern/plan';
import { targetGridColors, targetGridImage } from '@core/pattern/targetGrid';
import { createProject, createSlot } from '@core/project/defaults';
import { GRID_BACKGROUND, GRID_EMPTY, gridLayout } from '@core/project/publish';

const at = (image: { width: number; data: Uint8Array }, x: number, y: number) => {
  const i = (y * image.width + x) * 3;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};

describe('цвета позиций', () => {
  test('цель позиции — её образец; без цели и у закреплённой — null', () => {
    const warm = hardTarget(0.62, { hue: 70, chroma: 0.06 });
    const dark = hardTarget(levelL('D', DEFAULT_LEVELS));
    const project = createProject('p');
    project.slots = [createSlot('a', 'x'), createSlot('b'), createSlot('c', 'y'), createSlot('d')];
    project.slots = withPatternTargets(project.slots, makePattern('string', [warm, dark, warm]), 1);
    project.grid.pinned = 1;
    // Позиция 4 без цели: цели вписаны в файл без паттерна.
    const { target: _target, ...noTarget } = project.slots[3]!;
    project.slots[3] = noTarget;
    expect(targetGridColors(project)).toEqual([null, targetSwatch(dark), targetSwatch(warm), null]);
    // Закреплённая без цели, даже если цель вписана в файл проекта.
    project.slots[0] = { ...project.slots[0]!, target: warm };
    expect(targetGridColors(project)[0]).toBeNull();
  });
});

describe('пиксели целевой сетки', () => {
  test('размеры по gridLayout; плитка — цвет цели, без цели — GRID_EMPTY; промежутки — фон', () => {
    const colors: ([number, number, number] | null)[] = [[200, 10, 20], null, [0, 128, 255], [7, 8, 9]];
    const image = targetGridImage(colors, '3:4', 3);
    const layout = gridLayout(4, '3:4', 3);
    expect([image.width, image.height]).toEqual([layout.width, layout.height]);
    expect([image.width, image.height]).toEqual([1628, 1444]);
    expect(image.data.length).toBe(image.width * image.height * 3);
    colors.forEach((color, i) => {
      const [x, y] = layout.cells[i]!;
      const expected = color ?? [...GRID_EMPTY];
      for (const [dx, dy] of [
        [0, 0],
        [layout.tileWidth - 1, 0],
        [0, layout.tileHeight - 1],
        [layout.tileWidth - 1, layout.tileHeight - 1],
        [270, 360],
      ] as const) {
        expect(at(image, x + dx, y + dy), `плитка ${i + 1}, (${dx}, ${dy})`).toEqual(expected);
      }
    });
    // Промежуток между колонками и рядами, хвост последнего ряда — фон.
    expect(at(image, 540, 10)).toEqual([...GRID_BACKGROUND]);
    expect(at(image, 10, 720)).toEqual([...GRID_BACKGROUND]);
    expect(at(image, 600, 1000)).toEqual([...GRID_BACKGROUND]);
    // Одна заливка на плитку: все точки плитки 1 одного цвета.
    let same = 0;
    for (let y = 0; y < layout.tileHeight; y++) for (let x = 0; x < layout.tileWidth; x++) same += Number(at(image, x, y).join() === '200,10,20');
    expect(same).toBe(540 * 720);
  });

  test('квадратная сетка 1:1; без позиций — ошибка', () => {
    const image = targetGridImage([null, null, null, [1, 2, 3]], '1:1', 3);
    expect([image.width, image.height]).toEqual([1628, 1084]);
    expect(at(image, 0, 544)).toEqual([1, 2, 3]);
    expect(() => targetGridImage([], '3:4', 3)).toThrow(/нет позиций/);
  });
});
