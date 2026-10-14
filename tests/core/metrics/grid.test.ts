import { describe, expect, it } from 'vitest';
import { fitHarmony } from '@core/harmony/templates';
import { analyzeGrid, GRID_PALETTE_SIZE, gridPalette, neighborContrast } from '@core/metrics/grid';
import { createSlot } from '@core/project/defaults';
import type { Features, Project, Slot, Vec3 } from '@core/project/types';

const ASSET = 'aaaaaaaaaaaaaaaa';

/** Признаки однотонной плитки цвета lab. */
function features(lab: Vec3, palette: Features['palette'] = [{ lab, share: 1 }]): Features {
  return {
    meanL: lab[0],
    p05L: lab[0],
    p50L: lab[0],
    p95L: lab[0],
    lHist: new Array(8).fill(0),
    meanA: lab[1],
    meanB: lab[2],
    meanC: Math.hypot(lab[1], lab[2]),
    hueHist: new Array(12).fill(0),
    palette,
    neutralShare: 0,
    highKeyShare: 0,
    lowKeyShare: 0,
    busyness: 0,
  };
}

/**
 * Сетка по строке: символ — позиция. «L», «D», «M» — фото светлое, тёмное, среднее; «P» — опубликованное
 * светлое; «.» — пустая позиция; «?» — фото без посчитанных признаков.
 */
function grid(spec: string): { project: Pick<Project, 'grid' | 'slots'>; byId: Record<string, Features> } {
  const levels: Record<string, number> = { L: 0.8, P: 0.8, D: 0.35, M: 0.55 };
  const byId: Record<string, Features> = {};
  const slots: Slot[] = [...spec.replaceAll('/', '')].map((ch, i) => {
    const slot = createSlot(`s${i}`, ch === '.' ? undefined : ASSET);
    if (ch === '.') slot.state = 'empty';
    if (ch === 'P') slot.state = 'published';
    const L = levels[ch];
    if (L !== undefined) byId[slot.id] = features([L, 0, 0]);
    return slot;
  });
  return { project: { grid: { ratio: '3:4', columns: 3, pinned: 0 }, slots }, byId };
}

describe('карта яркости', () => {
  it('позиции по строкам, пустые и непосчитанные — пропуски', () => {
    const { project, byId } = grid('LD./?LP/D');
    const analysis = analyzeGrid(project, byId);
    expect(analysis.rows).toBe(3);
    expect(analysis.cells.map((c) => [c.row, c.column])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(analysis.cells.map((c) => c.L)).toEqual([0.8, 0.35, null, null, 0.8, 0.8, 0.35]);
    expect(analysis.cells.map((c) => c.photo)).toEqual([true, true, false, true, true, true, true]);
    expect(analysis.cells.map((c) => c.published)).toEqual([false, false, false, false, false, true, false]);
    expect(analysis.photos).toBe(6);
    expect(analysis.measured).toBe(5);
  });

  it('меньше 6 плиток с признаками — метрик сетки нет, карта есть', () => {
    const { project, byId } = grid('LDL/D?L');
    const analysis = analyzeGrid(project, byId);
    expect(analysis.metrics).toBeNull();
    expect(analysis.cells.filter((c) => c.L !== null)).toHaveLength(5);
    // Признаки шестой плитки пришли — анализ появился.
    byId['s4'] = features([0.8, 0, 0]);
    expect(analyzeGrid(project, byId).metrics).not.toBeNull();
  });

  it('шахматка: ритм, разброс и контраст соседей', () => {
    const { project, byId } = grid('LDL/DLD/LDL');
    const metrics = analyzeGrid(project, byId).metrics;
    if (!metrics || metrics.rhythm.kind !== 'pattern') throw new Error('ожидалась шахматка');
    expect(metrics.rhythm.best.template).toBe('checker');
    expect(metrics.rhythm.best.strength).toBeCloseTo(1, 12);
    // 5 светлых 0.8 и 4 тёмных 0.35: σ = 0.45 · √(5 · 4) / 9.
    expect(metrics.spread).toBeCloseTo((0.45 * Math.sqrt(20)) / 9, 12);
    expect(metrics.contrast.horizontal).toBeCloseTo(0.45, 12);
    expect(metrics.contrast.vertical).toBeCloseTo(0.45, 12);
  });

  it('опубликованные плитки входят в метрики как контекст', () => {
    const { project, byId } = grid('PDL/DLD/LDP');
    const metrics = analyzeGrid(project, byId).metrics;
    expect(metrics?.rhythm.kind).toBe('pattern');
    expect(metrics?.wheel).toHaveLength(9);
  });
});

describe('контраст соседей', () => {
  it('средняя |ΔL| по горизонтали и вертикали; строки не переносятся', () => {
    // 0.1 0.3 0.6
    // 0.2 0.2 0.9
    const contrast = neighborContrast([0.1, 0.3, 0.6, 0.2, 0.2, 0.9], 3);
    expect(contrast.horizontal).toBeCloseTo((0.2 + 0.3 + 0 + 0.7) / 4, 12);
    expect(contrast.vertical).toBeCloseTo((0.1 + 0.1 + 0.3) / 3, 12);
  });

  it('пары с пропуском не считаются; нет пар — null', () => {
    const contrast = neighborContrast([0.1, null, 0.5, 0.4, 0.4, null], 3);
    expect(contrast.horizontal).toBeCloseTo(0, 12);
    expect(contrast.vertical).toBeCloseTo(0.3, 12);
    expect(neighborContrast([0.1, 0.2, 0.3], 3).vertical).toBeNull();
    expect(neighborContrast([0.1, null, 0.3, null], 3).horizontal).toBeNull();
  });
});

describe('палитра сетки', () => {
  const hue = (h: number, L = 0.65, C = 0.12): Vec3 => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

  it('много разных цветов — не больше 7, доли в сумме 1, по убыванию', () => {
    const tiles = Array.from({ length: 12 }, (_, i) => features(hue(i * 30, 0.4 + (i % 3) * 0.2)));
    const result = gridPalette(tiles);
    expect(result.length).toBeGreaterThanOrEqual(5);
    expect(result.length).toBeLessThanOrEqual(GRID_PALETTE_SIZE);
    expect(result.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 12);
    for (let i = 1; i < result.length; i++) expect(result[i]!.share).toBeLessThanOrEqual(result[i - 1]!.share);
  });

  it('детерминирована: тот же вход — та же палитра', () => {
    const tiles = Array.from({ length: 20 }, (_, i) =>
      features(hue(i * 47), [
        { lab: hue(i * 47), share: 0.6 },
        { lab: hue(i * 47 + 180, 0.3, 0.05), share: 0.4 },
      ]),
    );
    expect(gridPalette(tiles)).toEqual(gridPalette(tiles));
  });

  it('каждая плитка весит одинаково, сколько бы цветов ни было в её палитре', () => {
    const warm = hue(60, 0.8, 0.08);
    const cold = hue(250, 0.4, 0.08);
    // Шесть тёплых — у части палитра из двух почти одинаковых цветов; три холодных.
    const tiles = [
      ...Array.from({ length: 3 }, () => features(warm)),
      ...Array.from({ length: 3 }, () =>
        features(warm, [
          { lab: warm, share: 0.5 },
          { lab: [warm[0] + 0.005, warm[1], warm[2]], share: 0.5 },
        ]),
      ),
      ...Array.from({ length: 3 }, () => features(cold)),
    ];
    const result = gridPalette(tiles);
    expect(result).toHaveLength(2);
    expect(result[0]!.share).toBeCloseTo(2 / 3, 12);
    expect(result[0]!.lab[0]).toBeCloseTo(0.8 + 0.005 / 4, 12);
    expect(result[1]!.share).toBeCloseTo(1 / 3, 12);
    result[1]!.lab.forEach((v, i) => expect(v).toBeCloseTo(cold[i] as number, 12));
  });

  it('в анализе — палитра плиток с признаками; точки колеса — тон и хрома среднего', () => {
    const { project, byId } = grid('LDL/DLD');
    byId['s0'] = features(hue(90, 0.8, 0.1));
    const metrics = analyzeGrid(project, byId).metrics;
    expect(metrics?.palette.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 12);
    const point = metrics?.wheel.find((p) => p.slotId === 's0');
    expect(point?.hue).toBeCloseTo(90, 9);
    expect(point?.chroma).toBeCloseTo(0.1, 12);
    expect(metrics?.wheel.find((p) => p.slotId === 's1')?.chroma).toBe(0);
  });
});

describe('гармония в анализе сетки', () => {
  const hue = (h: number, L = 0.65, C = 0.12): Vec3 => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

  it('по точкам колеса, опубликованные — контекст; у шаблона положение каждой точки', () => {
    const { project, byId } = grid('PLL/LLL/L.L');
    const hues = [40, 50, 60, 70, 80, 90, 200, 85];
    project.slots.filter((slot) => byId[slot.id]).forEach((slot, i) => (byId[slot.id] = features(hue(hues[i] as number))));
    const metrics = analyzeGrid(project, byId).metrics;
    if (!metrics || metrics.harmony.kind !== 'template') throw new Error('ожидался шаблон');
    expect(metrics.harmony).toEqual(fitHarmony(metrics.wheel));
    expect(metrics.harmony.best.template).toBe('V');
    expect(metrics.harmony.tiles).toHaveLength(8);
    // Чужой тон — плитка s6, опубликованная s0 внутри шаблона.
    const outside = metrics.wheel.filter((_, i) => metrics.harmony.kind === 'template' && metrics.harmony.tiles[i]?.outside);
    expect(outside.map((p) => p.slotId)).toEqual(['s6']);
  });

  it('серая сетка — нейтральная', () => {
    const { project, byId } = grid('LDL/DLD/LDL');
    expect(analyzeGrid(project, byId).metrics?.harmony.kind).toBe('neutral');
  });
});

describe('закреплённые (ADR 0022)', () => {
  it('закреплённая плитка любого цвета не меняет ритм, медианы, гармонию, палитру и выбросы; на карте видна с пометкой', () => {
    const { project, byId } = grid('LDL/DLD/LDL/DLD');
    // Цветная шахматка: светлые тёплые, тёмные холодные; плитка 5 на светлом месте темнее — выброс.
    for (const [id, f] of Object.entries(byId)) {
      const light = f.meanL > 0.5;
      byId[id] = features([f.meanL, light ? 0.03 : -0.02, light ? 0.06 : -0.05]);
    }
    byId['s4'] = features([0.62, 0.03, 0.06]);
    const pinned: Pick<Project, 'grid' | 'slots'> = { ...project, grid: { ...project.grid, pinned: 1 } };
    const without = analyzeGrid(project, { ...byId, s0: undefined });
    expect(without.outliers.map((o) => o.index)).toContain(4);
    expect(without.metrics?.palette.length).toBeGreaterThan(1);

    for (const lab of [
      [0.1, 0.2, -0.1],
      [0.95, -0.1, 0.1],
      [0.8, 0.03, 0.06],
    ] as Vec3[]) {
      const analysis = analyzeGrid(pinned, { ...byId, s0: features(lab) });
      expect(analysis.metrics).toEqual(without.metrics);
      expect(analysis.expectations).toEqual(without.expectations);
      expect(analysis.outliers).toEqual(without.outliers);
      expect(analysis.measured).toBe(11);
      expect(analysis.photos).toBe(11);
      expect(analysis.cells[0]).toMatchObject({ index: 0, pinned: true, photo: true, L: lab[0] });
      expect(analysis.cells.slice(1).every((cell) => !cell.pinned)).toBe(true);
    }

    // Цель закреплённой позиции не проверяется: закреплённые вне анализа.
    const slots = pinned.slots.map((slot, i) => (i === 0 ? { ...slot, target: { L: 0.2, tolerance: { L: 0.06, hue: 15, chroma: 0.02 }, hard: true } } : slot));
    const withTarget = analyzeGrid({ ...pinned, slots }, { ...byId, s0: features([0.8, 0, 0]) });
    expect(withTarget.expectations.some((e) => e.slotId === 's0')).toBe(false);
  });

  it('меньше 6 плиток в ленте — анализа сетки нет, даже если с закреплёнными их 6', () => {
    const { project, byId } = grid('LDL/DLD');
    expect(analyzeGrid(project, byId).metrics).not.toBeNull();
    const analysis = analyzeGrid({ ...project, grid: { ...project.grid, pinned: 2 } }, byId);
    expect(analysis.metrics).toBeNull();
    expect(analysis.photos).toBe(4);
    expect(analysis.cells.filter((cell) => cell.pinned).map((cell) => cell.L)).toEqual([0.8, 0.35]);
  });
});
