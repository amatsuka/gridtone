// `Цели.png` — картинка целевой сетки (docs/decisions/0026-content-plan.md): плитки 540 px в той же раскладке, что
// `Сетка.png` (gridLayout), каждая залита образцом цели своей позиции; позиция без цели и закреплённая — GRID_EMPTY,
// промежутки — GRID_BACKGROUND. Пиксели считает core, PNG пишет utility process.
import { isPinnedIndex } from '../project/slots';
import { GRID_BACKGROUND, GRID_EMPTY, gridLayout } from '../project/publish';
import type { Project, Ratio } from '../project/types';
import { targetSwatch, type Rgb8 } from './plan';

/** Картинка RGB 8 бит без альфы, строки сверху вниз. */
export interface Rgb8Image {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Цвет каждой позиции по порядку сетки: образец её цели; без цели и у закреплённой — null. */
export function targetGridColors(project: Pick<Project, 'slots' | 'grid'>): (Rgb8 | null)[] {
  return project.slots.map((slot, i) => (slot.target && !isPinnedIndex(i, project.grid.pinned) ? targetSwatch(slot.target) : null));
}

/** Пиксели `Цели.png`: colors — по позициям сетки, null — GRID_EMPTY. */
export function targetGridImage(colors: readonly (readonly number[] | null)[], ratio: Ratio, columns: number): Rgb8Image {
  if (colors.length === 0) throw new Error('в сетке нет позиций');
  const layout = gridLayout(colors.length, ratio, columns);
  const { width, height, tileWidth, tileHeight } = layout;
  const data = new Uint8Array(width * height * 3);
  fill(data, 0, width * height, GRID_BACKGROUND);
  colors.forEach((color, i) => {
    const [x, y] = layout.cells[i] as [number, number];
    for (let row = 0; row < tileHeight; row++) fill(data, (y + row) * width + x, tileWidth, color ?? GRID_EMPTY);
  });
  return { width, height, data };
}

/** count точек подряд с точки start заливаются цветом. */
function fill(data: Uint8Array, start: number, count: number, [r = 0, g = 0, b = 0]: readonly number[]): void {
  for (let i = start * 3, end = (start + count) * 3; i < end; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}
