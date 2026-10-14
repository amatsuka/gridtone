import { describe, expect, it } from 'vitest';
import { fileStem } from '@core/project/fileNames';
import { createProject, createSlot } from '@core/project/defaults';
import {
  GRID_GAP,
  GRID_TILE_WIDTH,
  UPSCALE_WARN_BELOW,
  formatNumbers,
  gridLayout,
  planNotes,
  planOrder,
  postFileBases,
  postSize,
  prescaleSize,
  publishOrder,
} from '@core/project/publish';
import type { Slot } from '@core/project/types';

function slot(id: string, state: Slot['state']): Slot {
  const s = createSlot(id, state === 'empty' ? undefined : `asset-${id}`);
  s.state = state;
  return s;
}

describe('порядок публикации', () => {
  it('последняя плитка сетки публикуется первой; опубликованные и пустые пропускаются', () => {
    const slots = [slot('a', 'planned'), slot('b', 'published'), slot('c', 'planned'), slot('d', 'empty'), slot('e', 'planned')];
    expect(publishOrder(slots, 0)).toEqual([4, 2, 0]);
  });

  it('запланированная позиция без фото не публикуется', () => {
    const s = slot('a', 'planned');
    delete s.assetId;
    expect(publishOrder([s, slot('b', 'planned')], 0)).toEqual([1]);
    expect(publishOrder([], 0)).toEqual([]);
  });

  it('новый проект: все плитки в обратном порядке', () => {
    const p = createProject('Сетка');
    p.slots = ['1', '2', '3'].map((id) => createSlot(id, `asset-${id}`));
    expect(publishOrder(p.slots, p.grid.pinned)).toEqual([2, 1, 0]);
  });
});

describe('имена постов', () => {
  it('имя оригинала без пути и расширения', () => {
    expect(fileStem('/Users/a/Фото/рампа.jpg')).toBe('рампа');
    expect(fileStem('C:\\Фото\\Отпуск 2026\\IMG_0001.HEIC.tif')).toBe('IMG_0001.HEIC');
    expect(fileStem('/a/b/без расширения')).toBe('без расширения');
    expect(fileStem('/a/b/.скрытый')).toBe('.скрытый');
  });

  /** Посты подряд с номерами 1…n, как без пустых позиций. */
  const inRow = (stems: string[]) => stems.map((stem, i) => ({ number: i + 1, stem, pin: false }));

  it('номер в порядке публикации и имя оригинала; номера одной ширины', () => {
    expect(postFileBases(inRow(['рампа', 'однотонное', 'полосы']), 3)).toEqual(['1 — рампа', '2 — однотонное', '3 — полосы']);
    const twelve = postFileBases(inRow(Array.from({ length: 12 }, (_, i) => `IMG_${i}`)), 12);
    expect(twelve[0]).toBe('01 — IMG_0');
    expect(twelve[11]).toBe('12 — IMG_11');
    expect(postFileBases(inRow(Array.from({ length: 100 }, () => 'x')), 100)[4]).toBe('005 — x');
  });

  it('номера — из плана: у пустых позиций пропуски, ширина — по числу позиций плана; закреплённый — «(закрепить)»', () => {
    const posts = [
      { number: 1, stem: 'a', pin: false },
      { number: 4, stem: 'b', pin: false },
      { number: 12, stem: 'c', pin: true },
    ];
    expect(postFileBases(posts, 12)).toEqual(['01 — a', '04 — b', '12 — c (закрепить)']);
  });

  it('имя чистится как у образов; от пустого остаётся номер', () => {
    expect(postFileBases(inRow(['a/b:c', '...', ' ']), 3)).toEqual(['1 — a-b-c', '2 — фото', '3 — фото']);
  });

  it('занятые имена (карта, сетка, образы) не повторяются, регистр не различается', () => {
    expect(postFileBases(inRow(['рампа']), 1, ['1 — Рампа', 'Сетка'])).toEqual(['1 — рампа 2']);
  });
});

describe('план публикации (ADR 0022)', () => {
  /**
   * Сетка из букв: строчная — запланированный пост, заглавная — опубликованный, «.» — пустая позиция.
   * id слота — буква в нижнем регистре или «e<позиция>» у пустой.
   */
  function grid(spec: string): Slot[] {
    return [...spec].map((ch, i) => (ch === '.' ? slot(`e${i}`, 'empty') : slot(ch.toLowerCase(), ch === ch.toLowerCase() ? 'planned' : 'published')));
  }
  const brief = (slots: Slot[], pinned: number) =>
    planOrder(slots, pinned).map((e) => `${e.number}:${e.slotId}${e.photo ? '' : '∅'}${e.pin ? '^' : ''}${e.belowPublished ? '!' : ''}`);

  it('снизу вверх: пустые получают номера, опубликованные пропускаются, закреплённые — последними, снизу вверх', () => {
    // Закреплены a и b (опубликован); дальше лента: пустая, c, опубликованный d, пустая, f.
    const slots = grid('aB.cD.f');
    expect(brief(slots, 2)).toEqual(['1:f!', '2:e5∅!', '3:c', '4:e2∅', '5:a^']);
    const entries = planOrder(slots, 2);
    expect(entries.map((e) => e.index)).toEqual([6, 5, 3, 2, 0]);
    expect(publishOrder(slots, 2)).toEqual([6, 3, 0]);
    // Без закреплённых: a — обычный пост, номер по месту в сетке.
    expect(brief(grid('ab.'), 0)).toEqual(['1:e2∅', '2:b', '3:a']);
    expect(brief(grid('abc'), 2)).toEqual(['1:c', '2:b^', '3:a^']);
  });

  it('пустая закреплённая позиция — номер с «закрепить»; закреплённых больше, чем слотов', () => {
    expect(brief(grid('.ab'), 1)).toEqual(['1:b', '2:a', '3:e0∅^']);
    expect(brief(grid('ab'), 3)).toEqual(['1:b^', '2:a^']);
    expect(brief([], 3)).toEqual([]);
  });

  it('ниже опубликованного — только в ленте: опубликованный закреплённый не в счёт', () => {
    expect(brief(grid('Abc'), 1)).toEqual(['1:c', '2:b']);
    expect(brief(grid('aBc'), 0)).toEqual(['1:c!', '2:a']);
    expect(brief(grid('aBC.'), 0)).toEqual(['1:e3∅!', '2:a']);
  });

  it('оговорки плана: пустые позиции и посты ниже опубликованного', () => {
    expect(planNotes(planOrder(grid('abc'), 0))).toEqual([]);
    expect(planNotes(planOrder(grid('a.b'), 0))).toEqual(['Пост 2 — пустая позиция: номер пропущен, файла нет.']);
    expect(planNotes(planOrder(grid('...a..Bc'), 0))).toEqual([
      'Посты 2, 3, 5–7 — пустые позиции: номера пропущены, файлов нет.',
      'Пост 1 ниже опубликованного: на этом месте его не опубликовать.',
    ]);
    expect(planNotes(planOrder(grid('aBcd'), 0))).toEqual(['Посты 1, 2 ниже опубликованного: на этих местах их не опубликовать.']);
  });

  it('номера списком: подряд от трёх — диапазоном', () => {
    expect(formatNumbers([1])).toBe('1');
    expect(formatNumbers([1, 2])).toBe('1, 2');
    expect(formatNumbers([1, 2, 3, 5, 7, 8, 9, 10])).toBe('1–3, 5, 7–10');
  });
});

describe('размеры', () => {
  it('пост — 1080 по ширине, высота по пропорциям кадра ленты', () => {
    expect(postSize('4:5')).toEqual([1080, 1350]);
    expect(postSize('3:4')).toEqual([1080, 1440]);
    expect(postSize('1:1')).toEqual([1080, 1080]);
  });

  it('сетка: 3 колонки, плитка 540 px, промежутки, неполный последний ряд', () => {
    const layout = gridLayout(7, '3:4', 3);
    expect([layout.tileWidth, layout.tileHeight]).toEqual([GRID_TILE_WIDTH, 720]);
    expect(layout.width).toBe(3 * 540 + 2 * GRID_GAP);
    expect(layout.height).toBe(3 * 720 + 2 * GRID_GAP);
    expect(layout.cells).toHaveLength(7);
    expect(layout.cells[0]).toEqual([0, 0]);
    expect(layout.cells[2]).toEqual([2 * (540 + GRID_GAP), 0]);
    expect(layout.cells[3]).toEqual([0, 720 + GRID_GAP]);
    expect(layout.cells[6]).toEqual([0, 2 * (720 + GRID_GAP)]);
    const square = gridLayout(3, '1:1', 3);
    expect([square.width, square.height, square.tileHeight]).toEqual([3 * 540 + 2 * GRID_GAP, 540, 540]);
  });

  it('плитки не пересекаются и лежат внутри картинки', () => {
    const layout = gridLayout(10, '3:4', 3);
    const { tileWidth: w, tileHeight: h } = layout;
    for (const [i, [x, y]] of layout.cells.entries()) {
      expect(x + w).toBeLessThanOrEqual(layout.width);
      expect(y + h).toBeLessThanOrEqual(layout.height);
      for (const [x2, y2] of layout.cells.slice(i + 1)) expect(x + w <= x2 || x2 + w <= x || y + h <= y2 || y2 + h <= y).toBe(true);
    }
  });

  it('предуменьшение — до двух точек оригинала на точку выхода; мелкий оригинал не трогается', () => {
    expect(prescaleSize(4000, 3000, 4)).toEqual([2000, 1500]);
    expect(prescaleSize(4000, 3000, 2.5)).toEqual([3200, 2400]);
    expect(prescaleSize(4000, 3000, 2)).toBeNull();
    expect(prescaleSize(1000, 800, 0.8)).toBeNull();
    expect(prescaleSize(3, 3, 1000)).toEqual([1, 1]);
    expect(UPSCALE_WARN_BELOW).toBeLessThan(1);
  });
});
