// Задача о назначениях (docs/spec.md, «Подогнать текущую сетку» и «Поиск» модуля 5; docs/decisions/0025-fit.md):
// каждой строке — свой столбец так, чтобы сумма стоимостей была наименьшей. Венгерский алгоритм с потенциалами,
// O(n² · m): на 90 × 90 — доли миллисекунды. Свой, без зависимостей; его возьмёт подбор комплекта этапа 6.
// Предпочтение «остаться на месте» в матрицу закладывает вызывающий (pattern/fit.ts), алгоритм о нём не знает.

/**
 * Назначение строк столбцам с наименьшей суммой. Результат — столбец каждой строки. Строк больше, чем
 * столбцов, — назначается по строке на каждый столбец, у лишних строк −1.
 */
export function assign(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length;
  if (rows === 0) return [];
  const columns = (cost[0] as readonly number[]).length;
  for (const row of cost) {
    if (row.length !== columns) throw new Error('строки матрицы стоимостей разной длины');
    for (const value of row) if (!Number.isFinite(value)) throw new Error(`стоимость назначения не число: ${value}`);
  }
  if (columns === 0) return new Array<number>(rows).fill(-1);
  if (rows <= columns) return hungarian(rows, columns, (i, j) => (cost[i] as readonly number[])[j] as number);
  // Строк больше: решаем для транспонированной и переворачиваем ответ.
  const byColumn = hungarian(columns, rows, (i, j) => (cost[j] as readonly number[])[i] as number);
  const result = new Array<number>(rows).fill(-1);
  byColumn.forEach((row, column) => {
    result[row] = column;
  });
  return result;
}

/** Сумма стоимостей назначения; неназначенные строки (−1) не входят. */
export function assignmentCost(cost: readonly (readonly number[])[], assignment: readonly number[]): number {
  return assignment.reduce((sum, j, i) => (j < 0 ? sum : sum + ((cost[i] as readonly number[])[j] as number)), 0);
}

/**
 * Венгерский алгоритм для n ≤ m (e-maxx): строки добавляются по одной, кратчайший увеличивающий путь ищется
 * по приведённым стоимостям a[i][j] − u[i] − v[j] ≥ 0. Индексы внутри — с 1, нулевой столбец фиктивный.
 */
function hungarian(n: number, m: number, a: (i: number, j: number) => number): number[] {
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  /** p[j] — строка, назначенная столбцу j (0 — никто). */
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0] as number;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const reduced = a(i0 - 1, j - 1) - (u[i0] as number) - (v[j] as number);
        if (reduced < (minv[j] as number)) {
          minv[j] = reduced;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Разворачиваем увеличивающий путь.
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const row = p[j] as number;
    if (row > 0) result[row - 1] = j - 1;
  }
  return result;
}
