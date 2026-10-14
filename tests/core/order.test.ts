import { describe, expect, test } from 'vitest';
import { createSlot } from '@core/project/defaults';
import { moveSlots, shiftSlots } from '@core/project/order';
import type { Slot } from '@core/project/types';

/** Сетка из букв; заглавная — опубликованный пост, цифра — пустая позиция. */
function grid(spec: string): Slot[] {
  return [...spec].map((ch) => {
    if (/\d/.test(ch)) return createSlot(ch);
    const slot = createSlot(ch.toLowerCase(), 'aaaaaaaaaaaaaaaa');
    if (ch !== ch.toLowerCase()) slot.state = 'published';
    return slot;
  });
}

const order = (slots: readonly Slot[]) => slots.map((s) => (s.state === 'published' ? s.id.toUpperCase() : s.id)).join('');

describe('moveSlots: перетаскивание', () => {
  test.each([
    ['abcdefghi', ['a'], 4, 'bcdeafghi'],
    ['abcdefghi', ['e'], 0, 'eabcdfghi'],
    ['abcde', ['d'], 1, 'adbce'],
    ['abcde', ['a'], 99, 'bcdea'],
    ['abcde', ['c'], -3, 'cabde'],
    ['abcde', ['c'], 2, 'abcde'],
  ])('%s: %j на %i → %s', (spec, ids, to, expected) => {
    expect(order(moveSlots(grid(spec), ids, to, 0))).toBe(expected);
  });

  test('выделение едет блоком в прежнем порядке, первый встаёт на позицию', () => {
    expect(order(moveSlots(grid('abcdefg'), ['f', 'b', 'd'], 1, 0))).toBe('abdfceg');
    expect(order(moveSlots(grid('abcdefg'), ['b', 'd'], 3, 0))).toBe('acebdfg');
  });

  test('блок не выходит за конец сетки', () => {
    expect(order(moveSlots(grid('abcde'), ['a', 'b'], 4, 0))).toBe('cdeab');
  });

  test('опубликованные стоят на своих местах, остальные их обтекают', () => {
    expect(order(moveSlots(grid('aPbc'), ['a'], 2, 0))).toBe('bPac');
    expect(order(moveSlots(grid('PabQc'), ['c'], 0, 0))).toBe('PcaQb');
    expect(order(moveSlots(grid('abPcd'), ['a', 'b'], 3, 0))).toBe('cdPab');
  });

  test('опубликованные в выделении не двигаются, неизвестные id не мешают', () => {
    expect(order(moveSlots(grid('aPbc'), ['p', 'c', 'zz'], 0, 0))).toBe('cPab');
    expect(order(moveSlots(grid('aPb'), ['p'], 2, 0))).toBe('aPb');
  });

  test('без выделения порядок прежний, сами слоты те же объекты', () => {
    const slots = grid('abc');
    const result = moveSlots(slots, [], 1, 0);
    expect(result).toEqual(slots);
    result.forEach((slot, i) => expect(slot).toBe(slots[i]));
  });
});

describe('shiftSlots: сдвиг с клавиатуры', () => {
  test.each([
    ['abcdefghi', ['e'], 1, 'abcdfeghi'],
    ['abcdefghi', ['e'], -1, 'abcedfghi'],
    ['abcdefghi', ['b'], 3, 'acdebfghi'],
    ['abcdefghi', ['e'], -3, 'aebcdfghi'],
  ])('%s: %j на %i → %s', (spec, ids, delta, expected) => {
    expect(order(shiftSlots(grid(spec), ids, delta, 0))).toBe(expected);
  });

  test('промежутки внутри выделения сохраняются', () => {
    expect(order(shiftSlots(grid('abcdefg'), ['a', 'c'], 1, 0))).toBe('badcefg');
    expect(order(shiftSlots(grid('abcdefg'), ['b', 'd'], 3, 0))).toBe('acefbgd');
  });

  test('у края сдвиг укорачивается, у самого края ничего не происходит', () => {
    expect(order(shiftSlots(grid('abcde'), ['c'], 3, 0))).toBe('abdec');
    expect(order(shiftSlots(grid('abcde'), ['a', 'e'], 1, 0))).toBe('abcde');
    expect(order(shiftSlots(grid('abcde'), ['a'], -1, 0))).toBe('abcde');
    expect(order(shiftSlots(grid('abcde'), ['b', 'c'], -3, 0))).toBe('bcade');
  });

  test('опубликованные не двигаются и не мешают сдвигу', () => {
    expect(order(shiftSlots(grid('aPbc'), ['a'], 1, 0))).toBe('bPac');
    expect(order(shiftSlots(grid('aPbc'), ['p'], 1, 0))).toBe('aPbc');
  });
});

describe('закреплённые и пустые позиции (ADR 0022)', () => {
  test('закреплённые не двигаются и никого к себе не пускают', () => {
    expect(order(moveSlots(grid('abcde'), ['c'], 0, 1))).toBe('acbde');
    expect(order(moveSlots(grid('abcde'), ['a'], 4, 1))).toBe('abcde');
    expect(order(moveSlots(grid('abcde'), ['a', 'd'], 1, 2))).toBe('abdce');
    expect(order(shiftSlots(grid('abcde'), ['b'], -1, 1))).toBe('abcde');
    expect(order(shiftSlots(grid('abcde'), ['d'], -3, 1))).toBe('adbce');
    expect(order(shiftSlots(grid('abcde'), ['a'], 1, 1))).toBe('abcde');
    expect(order(shiftSlots(grid('abcdE'), ['d'], 1, 3))).toBe('abcdE');
  });

  test('одна плитка на пустую позицию — обмен местами; блок и плитка на фото — как прежде', () => {
    expect(order(moveSlots(grid('a12bcd'), ['c'], 1, 0))).toBe('ac2b1d');
    expect(order(moveSlots(grid('a12bcd'), ['a'], 2, 0))).toBe('21abcd');
    expect(order(moveSlots(grid('a12bcd'), ['1'], 2, 0))).toBe('a21bcd');
    expect(order(moveSlots(grid('aP1b'), ['b'], 2, 0))).toBe('aPb1');
    // На себя, блоком, пустая на фото, на закреплённую пустую — обычная перестановка.
    expect(order(moveSlots(grid('a12bcd'), ['1'], 1, 0))).toBe('a12bcd');
    expect(order(moveSlots(grid('a12bcd'), ['b', 'c'], 1, 0))).toBe('abc12d');
    expect(order(moveSlots(grid('a12bcd'), ['1'], 4, 0))).toBe('a2bc1d');
    expect(order(moveSlots(grid('1abc'), ['b'], 0, 1))).toBe('1bac');
    // Сдвиг с клавиатуры на пустую позицию — тоже обмен.
    expect(order(shiftSlots(grid('ab1cde'), ['a'], 2, 0))).toBe('1bacde');
    expect(order(shiftSlots(grid('ab1cde'), ['a', 'b'], 2, 0))).toBe('1cabde');
    expect(order(shiftSlots(grid('ab1cde'), ['a'], 3, 0))).toBe('b1cade');
  });
});
