// Задача о назначениях — венгерский алгоритм (ADR 0025): против перебора, прямоугольные матрицы, скорость.
import { describe, expect, it } from 'vitest';
import { assign, assignmentCost } from '@core/match/assign';
import { mulberry32 } from '@core/random';

type Matrix = number[][];

function randomMatrix(rows: number, columns: number, seed: number, round = false): Matrix {
  const random = mulberry32(seed);
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => (round ? Math.floor(random() * 5) : random() * 10)));
}

/** Наименьшая сумма перебором: каждой строке — свой столбец (строк не больше столбцов) или наоборот. */
function bruteForce(cost: Matrix): number {
  const rows = cost.length;
  const columns = cost[0]?.length ?? 0;
  const k = Math.min(rows, columns);
  let best = Infinity;
  const usedRows = new Array<boolean>(rows).fill(false);
  const usedColumns = new Array<boolean>(columns).fill(false);
  // Назначаются k пар: перебираем по меньшей стороне.
  const byRows = rows <= columns;
  const walk = (depth: number, sum: number) => {
    if (sum >= best) return;
    if (depth === k) {
      best = sum;
      return;
    }
    const outer = byRows ? rows : columns;
    const inner = byRows ? columns : rows;
    const i = depth;
    if (i >= outer) return;
    for (let j = 0; j < inner; j++) {
      const used = byRows ? usedColumns : usedRows;
      if (used[j]) continue;
      used[j] = true;
      walk(depth + 1, sum + (byRows ? (cost[i] as number[])[j] as number : (cost[j] as number[])[i] as number));
      used[j] = false;
    }
  };
  walk(0, 0);
  return best;
}

/** Назначение корректно: у строк разные столбцы, в пределах матрицы; назначено min(строк, столбцов). */
function expectValid(cost: Matrix, result: number[]): void {
  const columns = cost[0]?.length ?? 0;
  expect(result).toHaveLength(cost.length);
  const assigned = result.filter((j) => j >= 0);
  expect(assigned).toHaveLength(Math.min(cost.length, columns));
  expect(new Set(assigned).size).toBe(assigned.length);
  for (const j of assigned) expect(j).toBeLessThan(columns);
}

describe('венгерский алгоритм', () => {
  it('квадратные матрицы до 8 × 8 — сумма как у перебора всех перестановок', () => {
    for (let n = 1; n <= 8; n++) {
      for (let seed = 1; seed <= 6; seed++) {
        const cost = randomMatrix(n, n, n * 100 + seed);
        const result = assign(cost);
        expectValid(cost, result);
        expect(assignmentCost(cost, result)).toBeCloseTo(bruteForce(cost), 9);
      }
    }
  });

  it('много равных стоимостей (целые 0–4) — всё равно оптимум', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const cost = randomMatrix(7, 7, seed, true);
      const result = assign(cost);
      expectValid(cost, result);
      expect(assignmentCost(cost, result)).toBe(bruteForce(cost));
    }
  });

  it('прямоугольные: строк меньше — каждая получает свой столбец; строк больше — каждый столбец свою строку', () => {
    for (const [rows, columns] of [
      [2, 5],
      [3, 7],
      [5, 8],
      [5, 2],
      [7, 3],
      [8, 5],
    ] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const cost = randomMatrix(rows, columns, rows * 1000 + columns * 10 + seed);
        const result = assign(cost);
        expectValid(cost, result);
        expect(assignmentCost(cost, result)).toBeCloseTo(bruteForce(cost), 9);
        if (rows > columns) expect(result.filter((j) => j === -1)).toHaveLength(rows - columns);
      }
    }
  });

  it('простые случаи: пустая матрица, одна клетка, очевидная перестановка', () => {
    expect(assign([])).toEqual([]);
    expect(assign([[3]])).toEqual([0]);
    expect(
      assign([
        [9, 1, 9],
        [1, 9, 9],
        [9, 9, 1],
      ]),
    ).toEqual([1, 0, 2]);
  });

  it('равные стоимости: с надбавкой ε за уход с места — без лишних перестановок', () => {
    const epsilon = 1e-6;
    const n = 6;
    // Все фото одинаково хороши везде: остаётся тождественное назначение.
    const flat = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => 2 + (i === j ? 0 : epsilon)));
    expect(assign(flat)).toEqual([0, 1, 2, 3, 4, 5]);
    // Две пары одинаковых фото: переставляется только то, что даёт выигрыш.
    const pairs = [
      [0, 5, 0, 5],
      [5, 0, 5, 0],
      [5, 0, 5, 0],
      [0, 5, 0, 5],
    ].map((row, i) => row.map((c, j) => c + (i === j ? 0 : epsilon)));
    const result = assign(pairs);
    expect(assignmentCost(pairs, result)).toBeCloseTo(2 * epsilon, 12);
    expect(result.filter((j, i) => j !== i)).toHaveLength(2);
  });

  it('стоимость не число — ошибка, а не тихо неверное назначение', () => {
    expect(() => assign([[1, Number.NaN]])).toThrow();
    expect(() => assign([[1, Infinity]])).toThrow();
    expect(() => assign([[1, 2], [3]])).toThrow();
  });

  it('90 × 90 — быстрее 50 мс', () => {
    const cost = randomMatrix(90, 90, 42);
    assign(cost);
    const start = performance.now();
    const result = assign(cost);
    const elapsed = performance.now() - start;
    expectValid(cost, result);
    expect(elapsed).toBeLessThan(50);
  });
});
