import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { describe, expect, test } from 'vitest';
import { History } from '../../src/renderer/history';

enablePatches();

interface Doc {
  a: number;
  b: number;
  list: string[];
}

/** Модель renderer: правка через Immer пишется в историю, отмена и повтор накладывают патчи. */
class Model {
  doc: Doc = { a: 0, b: 0, list: [] };
  readonly history: History<Patch>;

  constructor(limit?: number) {
    this.history = new History<Patch>(limit);
  }

  edit(recipe: (draft: Doc) => void, gesture?: string): void {
    const [doc, patches, inverse] = produceWithPatches(this.doc, recipe);
    this.doc = doc;
    this.history.record(patches, inverse, gesture);
  }

  undo(): boolean {
    const entry = this.history.undo();
    if (entry) this.doc = applyPatches(this.doc, entry.inverse);
    return entry !== undefined;
  }

  redo(): boolean {
    const entry = this.history.redo();
    if (entry) this.doc = applyPatches(this.doc, entry.patches);
    return entry !== undefined;
  }
}

describe('история правок', () => {
  test('отмена и повтор по одному действию', () => {
    const m = new Model();
    m.edit((d) => void (d.a = 1));
    m.edit((d) => void d.list.push('x'));
    expect(m.history.canUndo).toBe(true);
    expect(m.history.canRedo).toBe(false);

    m.undo();
    expect(m.doc).toEqual({ a: 1, b: 0, list: [] });
    m.undo();
    expect(m.doc).toEqual({ a: 0, b: 0, list: [] });
    expect(m.undo()).toBe(false);

    m.redo();
    m.redo();
    expect(m.doc).toEqual({ a: 1, b: 0, list: ['x'] });
    expect(m.redo()).toBe(false);
  });

  test('жест склеивается в одну запись и отменяется целиком', () => {
    const m = new Model();
    m.edit((d) => void (d.b = 5));
    for (let v = 1; v <= 10; v++) m.edit((d) => void (d.a = v), 'slider:a');
    m.undo();
    expect(m.doc).toEqual({ a: 0, b: 5, list: [] });
    m.redo();
    expect(m.doc.a).toBe(10);
    m.undo();
    m.undo();
    expect(m.doc).toEqual({ a: 0, b: 0, list: [] });
  });

  test('конец жеста, другой ключ и правка без ключа начинают новую запись', () => {
    const m = new Model();
    m.edit((d) => void (d.a = 1), 'g');
    m.history.endGesture();
    m.edit((d) => void (d.a = 2), 'g');
    m.edit((d) => void (d.b = 1), 'h');
    m.edit((d) => void (d.b = 2));
    m.edit((d) => void (d.b = 3));
    const states: Doc[] = [];
    while (m.undo()) states.push(m.doc);
    expect(states.map((s) => [s.a, s.b])).toEqual([
      [2, 2],
      [2, 1],
      [2, 0],
      [1, 0],
      [0, 0],
    ]);
  });

  test('после отмены жест не продолжается, а новая правка стирает повтор', () => {
    const m = new Model();
    m.edit((d) => void (d.a = 1), 'g');
    m.undo();
    m.edit((d) => void (d.a = 2), 'g');
    expect(m.history.canRedo).toBe(false);
    m.undo();
    expect(m.doc.a).toBe(0);
    expect(m.history.canUndo).toBe(false);
  });

  test('глубина ограничена, старые записи отбрасываются', () => {
    const m = new Model(3);
    for (let v = 1; v <= 5; v++) m.edit((d) => void (d.a = v));
    let undone = 0;
    while (m.undo()) undone++;
    expect(undone).toBe(3);
    expect(m.doc.a).toBe(2);
  });

  test('clear забывает всё', () => {
    const m = new Model();
    m.edit((d) => void (d.a = 1));
    m.undo();
    m.history.clear();
    expect(m.history.canUndo).toBe(false);
    expect(m.history.canRedo).toBe(false);
  });
});
