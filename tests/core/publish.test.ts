import { describe, expect, it } from 'vitest';
import { fileStem } from '@core/project/fileNames';
import { createProject, createSlot } from '@core/project/defaults';
import {
  GRID_GAP,
  GRID_TILE_WIDTH,
  UPSCALE_WARN_BELOW,
  gridLayout,
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
    expect(publishOrder(slots)).toEqual([4, 2, 0]);
  });

  it('запланированная позиция без фото не публикуется', () => {
    const s = slot('a', 'planned');
    delete s.assetId;
    expect(publishOrder([s, slot('b', 'planned')])).toEqual([1]);
    expect(publishOrder([])).toEqual([]);
  });

  it('новый проект: все плитки в обратном порядке', () => {
    const p = createProject('Сетка');
    p.slots = ['1', '2', '3'].map((id) => createSlot(id, `asset-${id}`));
    expect(publishOrder(p.slots)).toEqual([2, 1, 0]);
  });
});

describe('имена постов', () => {
  it('имя оригинала без пути и расширения', () => {
    expect(fileStem('/Users/a/Фото/рампа.jpg')).toBe('рампа');
    expect(fileStem('C:\\Фото\\Отпуск 2026\\IMG_0001.HEIC.tif')).toBe('IMG_0001.HEIC');
    expect(fileStem('/a/b/без расширения')).toBe('без расширения');
    expect(fileStem('/a/b/.скрытый')).toBe('.скрытый');
  });

  it('номер в порядке публикации и имя оригинала; номера одной ширины', () => {
    expect(postFileBases(['рампа', 'однотонное', 'полосы'])).toEqual(['1 — рампа', '2 — однотонное', '3 — полосы']);
    const twelve = postFileBases(Array.from({ length: 12 }, (_, i) => `IMG_${i}`));
    expect(twelve[0]).toBe('01 — IMG_0');
    expect(twelve[11]).toBe('12 — IMG_11');
    expect(postFileBases(Array.from({ length: 100 }, () => 'x'))[4]).toBe('005 — x');
  });

  it('имя чистится как у образов; от пустого остаётся номер', () => {
    expect(postFileBases(['a/b:c', '...', ' '])).toEqual(['1 — a-b-c', '2 — фото', '3 — фото']);
  });

  it('занятые имена (карта, сетка, образы) не повторяются, регистр не различается', () => {
    expect(postFileBases(['рампа'], ['1 — Рампа', 'Сетка'])).toEqual(['1 — рампа 2']);
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
