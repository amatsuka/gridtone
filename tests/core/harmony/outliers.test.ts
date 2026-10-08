import { describe, expect, it } from 'vitest';
import { expectedL, GRID_TOLERANCE, median, outliersOf, type TileExpectation } from '@core/harmony/outliers';
import { HARMONY_EDGE_TOLERANCE } from '@core/harmony/templates';
import { deviation, DEVIATION_HUE_CHROMA, hueChromaWeight } from '@core/metrics/deviation';
import { meanHue, TEMPERATURE_AXIS, temperature, TINT_AXIS } from '@core/metrics/features';
import { analyzeGrid, type GridAnalysis } from '@core/metrics/grid';
import type { Rhythm } from '@core/metrics/rhythm';
import { createSlot } from '@core/project/defaults';
import type { Features, Project, Slot, SlotTarget } from '@core/project/types';

const ASSET = 'aaaaaaaaaaaaaaaa';

interface TileSpec {
  L: number;
  /** Средний (a, b): по ним температура, тон и хрома точки колеса. */
  a?: number;
  b?: number;
  /** Средняя хрома пикселей; по умолчанию — хрома среднего. */
  C?: number;
  published?: boolean;
  target?: SlotTarget;
}

/** Признаки однотонной плитки: средний цвет и средняя хрома задаются отдельно. */
function features({ L, a = 0, b = 0, C = Math.hypot(a, b) }: TileSpec): Features {
  return {
    meanL: L,
    p05L: L,
    p50L: L,
    p95L: L,
    lHist: new Array(8).fill(0),
    meanA: a,
    meanB: b,
    meanC: C,
    hueHist: new Array(12).fill(0),
    palette: [{ lab: [L, a, b], share: 1 }],
    neutralShare: 0,
    highKeyShare: 0,
    lowKeyShare: 0,
    busyness: 0,
  };
}

/** Сетка по плиткам: null — пустая позиция. */
function grid(tiles: readonly (TileSpec | number | null)[]): { project: Pick<Project, 'grid' | 'slots'>; byId: Record<string, Features> } {
  const byId: Record<string, Features> = {};
  const slots: Slot[] = tiles.map((spec, i) => {
    const slot = createSlot(`s${i}`, spec === null ? undefined : ASSET);
    if (spec === null) {
      slot.state = 'empty';
      return slot;
    }
    const tile = typeof spec === 'number' ? { L: spec } : spec;
    if (tile.published) slot.state = 'published';
    if (tile.target) slot.target = tile.target;
    byId[slot.id] = features(tile);
    return slot;
  });
  return { project: { grid: { ratio: '3:4', columns: 3, pinned: 0 }, slots }, byId };
}

function analyze(tiles: readonly (TileSpec | number | null)[]): GridAnalysis {
  const { project, byId } = grid(tiles);
  return analyzeGrid(project, byId);
}

function expectation(analysis: GridAnalysis, index: number): TileExpectation {
  const found = analysis.expectations.find((e) => e.index === index);
  if (!found) throw new Error(`у плитки ${index + 1} нет ожидания`);
  return found;
}

const partOf = (e: TileExpectation, reason: string) => e.parts.find((p) => p.reason === reason);
const reasonsOf = (e: TileExpectation) => e.reasons.map((p) => p.reason);

/** Точка (a, b) с тоном hue и хромой C. */
const ab = (hue: number, C: number) => ({ a: C * Math.cos((hue * Math.PI) / 180), b: C * Math.sin((hue * Math.PI) / 180) });
const deg = ([x, y]: readonly [number, number]) => (Math.atan2(y, x) * 180) / Math.PI;
/**
 * Тон, где температура цветов одной хромы наименьшая: перпендикуляр к оси оттенка, около 239°. Тона,
 * симметричные относительно него, при одной хроме дают одну температуру — так плитка отходит по тону,
 * не меняя ни температуры, ни хромы.
 */
const COLDEST = deg(TINT_AXIS) + 270;

// Шахматка на трёх колонках: класс 0 — позиции 0, 2, 4, 6, 8; класс 1 — 1, 3, 5, 7.
const LIGHT = [0.8, 0.82, 0.62, 0.84, 0.86];
const DARK = [0.4, 0.42, 0.44, 0.46];
/** Шахматка из 9: плитка 5 (позиция 4) на светлом месте темнее нужного. */
const checker = (light = LIGHT, dark = DARK): number[] => [light[0]!, dark[0]!, light[1]!, dark[1]!, light[2]!, dark[2]!, light[3]!, dark[3]!, light[4]!];

describe('ожидание яркости', () => {
  it('ритм распознан — медиана других плиток её класса; сама плитка в медиану не входит', () => {
    const analysis = analyze(checker());
    expect(analysis.metrics?.rhythm.kind).toBe('pattern');
    const e = expectation(analysis, 4);
    expect(e.source).toBe('grid');
    expect(e.basis).toBe('class');
    // Остальные светлые: 0.8, 0.82, 0.84, 0.86 — медиана 0.83; с самой плиткой была бы 0.82.
    expect(partOf(e, 'L')?.expected).toBeCloseTo(0.83, 12);
    expect(partOf(e, 'L')?.ratio).toBeCloseTo(0.21 / GRID_TOLERANCE.L, 12);
    expect(reasonsOf(e)).toEqual(['L']);
    // Тёмная плитка — по тёмным: 0.42, 0.44, 0.46.
    expect(partOf(expectation(analysis, 1), 'L')?.expected).toBeCloseTo(0.44, 12);
    // Других выбросов нет: светлая 0.8 против 0.83 — в допуске.
    expect(analysis.outliers.map((o) => o.index)).toEqual([4]);
  });

  it('ритма нет — медиана остальных плиток сетки', () => {
    const values = [0.5, 0.51, 0.49, 0.5, 0.62, 0.48, 0.5, 0.51, 0.49];
    const analysis = analyze(values);
    expect(analysis.metrics?.rhythm.kind).not.toBe('pattern');
    const e = expectation(analysis, 4);
    expect(e.basis).toBe('median');
    expect(partOf(e, 'L')?.expected).toBeCloseTo(median(values.filter((_, i) => i !== 4)), 12);
    expect(reasonsOf(e)).toEqual(['L']);
    expect(analysis.outliers.map((o) => o.index)).toEqual([4]);
  });

  it('«ровная» сетка — тоже медиана', () => {
    const analysis = analyze([0.5, 0.51, 0.49, 0.5, 0.52, 0.48, 0.5, 0.51, 0.49]);
    expect(analysis.metrics?.rhythm.kind).toBe('flat');
    expect(analysis.expectations.every((e) => e.basis === 'median' && e.reasons.length === 0)).toBe(true);
  });

  it('градиент — прямая через остальные плитки в её позиции', () => {
    const values = Array.from({ length: 9 }, (_, i) => 0.9 - 0.05 * i);
    values[4] = 0.7 + 0.15;
    const analysis = analyze(values);
    const rhythm = analysis.metrics?.rhythm;
    expect(rhythm?.kind === 'pattern' && rhythm.best.template).toBe('gradient');
    const e = expectation(analysis, 4);
    expect(e.basis).toBe('gradient');
    expect(partOf(e, 'L')?.expected).toBeCloseTo(0.7, 12);
    expect(analysis.outliers.map((o) => o.index)).toEqual([4]);
  });

  it('в классе больше никого — медиана сетки', () => {
    const rhythm: Rhythm = {
      kind: 'pattern',
      spread: 0.2,
      best: { template: 'checker', strength: 0.9, r2: 0.9, predictors: 1 },
      fits: [],
    };
    // Позиция 1 — класс 1, другие плитки — только класса 0.
    const others = [0, 2, 4].map((index) => ({ index, L: 0.8 + index / 100 }));
    const alone = expectedL({ index: 1 }, others, rhythm, 3);
    expect(alone.basis).toBe('median');
    expect(alone.L).toBeCloseTo(0.82, 12);
    const mates = expectedL({ index: 6 }, others, rhythm, 3);
    expect(mates.basis).toBe('class');
    expect(mates.L).toBeCloseTo(0.82, 12);
  });
});

describe('цель позиции', () => {
  it('у плитки с целью ожидание — цель, а не соседи', () => {
    const tiles: (TileSpec | number)[] = checker();
    // Тёмная плитка на светлом месте, но цель — её же L: в цели, хотя соседи ждут светлую.
    tiles[4] = { L: 0.62, target: { L: 0.62, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true } };
    // Светлая плитка в своём классе, но цель — тёмная.
    tiles[0] = { L: 0.8, target: { L: 0.5, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true } };
    const analysis = analyze(tiles);
    const inTarget = expectation(analysis, 4);
    expect(inTarget.source).toBe('target');
    expect(inTarget.basis).toBeUndefined();
    expect(inTarget.deviation).toBe(0);
    const far = expectation(analysis, 0);
    expect(far.source).toBe('target');
    expect(partOf(far, 'L')?.expected).toBe(0.5);
    expect(far.deviation).toBeCloseTo(0.3 / 0.05, 12);
    // У цели проверяется только то, что она задаёт: температуры и тона нет.
    expect(far.parts.map((p) => p.reason)).toEqual(['L']);
    expect(analysis.outliers.map((o) => o.index)).toEqual([0]);
  });

  it('отклонение от цели — то же число, что режим 7 считал по цели (ADR 0012)', () => {
    const target: SlotTarget = { L: 0.6, hue: 200, chroma: 0.05, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: false };
    const tile: TileSpec = { L: 0.63, ...ab(240, 0.03), C: 0.04, target };
    const analysis = analyze([tile, 0.5, 0.5]);
    const e = expectation(analysis, 0);
    const f = features(tile);
    expect(e.deviation).toBe(deviation({ meanL: f.meanL, meanC: f.meanC, hue: meanHue(f.meanA, f.meanB) }, target));
    expect(e.parts.map((p) => p.reason)).toEqual(['L', 'chroma', 'hue']);
  });

  it('меньше 6 плиток — ожидание только у плиток с целью', () => {
    const target: SlotTarget = { L: 0.5, tolerance: { L: 0.05, hue: 20, chroma: 0.04 }, hard: true };
    const analysis = analyze([{ L: 0.7, target }, 0.6, 0.5, 0.4, 0.3]);
    expect(analysis.metrics).toBeNull();
    expect(analysis.expectations.map((e) => e.index)).toEqual([0]);
    expect(analysis.outliers.map((o) => o.index)).toEqual([0]);
  });
});

describe('допуски и шкала', () => {
  it('отклонение — худшая часть в долях допуска: край допуска — 1', () => {
    const values = [0.5, 0.5, 0.5, 0.5, 0.5 + GRID_TOLERANCE.L, 0.5, 0.5, 0.5, 0.5];
    const e = expectation(analyze(values), 4);
    expect(e.deviation).toBeCloseTo(1, 12);
    expect(e.deviation).toBe(Math.max(...e.parts.map((p) => p.ratio)));
  });

  it('яркость, температура и хрома: больше допуска — причина, меньше — нет', () => {
    // Серая сетка: гармония нейтральная, тон не проверяется.
    const [ua, ub] = TEMPERATURE_AXIS;
    const warm = (k: number): TileSpec => ({ L: 0.5, a: ua * k * GRID_TOLERANCE.temperature, b: ub * k * GRID_TOLERANCE.temperature, C: 0 });
    const tiles: TileSpec[] = [
      { L: 0.5 + 1.1 * GRID_TOLERANCE.L },
      { L: 0.5 - 0.9 * GRID_TOLERANCE.L },
      warm(1.2),
      warm(0.8),
      { L: 0.5, C: 1.3 * GRID_TOLERANCE.chroma },
      { L: 0.5, C: 0.7 * GRID_TOLERANCE.chroma },
      { L: 0.5 },
      { L: 0.5 },
      { L: 0.5 },
    ];
    const analysis = analyze(tiles);
    expect(analysis.metrics?.harmony.kind).toBe('neutral');
    const reasons = analysis.expectations.map(reasonsOf);
    expect(reasons).toEqual([['L'], [], ['temperature'], [], ['chroma'], [], [], [], []]);
    const T = partOf(expectation(analysis, 2), 'temperature');
    expect(T?.value).toBeCloseTo(1.2 * GRID_TOLERANCE.temperature, 12);
    expect(T?.expected).toBeCloseTo(0, 12);
    expect(T?.ratio).toBeCloseTo(1.2, 12);
    expect(partOf(expectation(analysis, 4), 'chroma')?.ratio).toBeCloseTo(1.3, 12);
    // Нейтральная сетка: части тона нет ни у кого.
    expect(analysis.expectations.every((e) => !partOf(e, 'hue'))).toBe(true);
  });

  it('температура и хрома — медианы остальных плиток, опубликованные входят', () => {
    const tiles: TileSpec[] = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09].map((C, i) => ({ L: 0.5, C, published: i === 8 }));
    const analysis = analyze(tiles);
    expect(partOf(expectation(analysis, 0), 'chroma')?.expected).toBeCloseTo(0.055, 12);
    expect(partOf(expectation(analysis, 8), 'chroma')?.expected).toBeCloseTo(0.045, 12);
  });
});

describe('тон вне секторов', () => {
  /** Восемь плиток одного холодного тона и одна в 60° от них: та же хрома и та же температура. */
  function coldGrid(outlierChroma: number, outlierMeanC = outlierChroma): TileSpec[] {
    const base = { L: 0.6, ...ab(COLDEST - 30, 0.1) };
    const tiles: TileSpec[] = Array.from({ length: 9 }, (_, i) => ({ ...base, L: i % 2 === 0 ? 0.75 : 0.45 }));
    tiles[4] = { L: 0.75, ...ab(COLDEST + 30, outlierChroma), C: outlierMeanC };
    return tiles;
  }

  it('плитка чужого тона — причина «тон», ожидание — ближайший край сектора', () => {
    const analysis = analyze(coldGrid(0.1));
    const harmony = analysis.metrics?.harmony;
    if (harmony?.kind !== 'template') throw new Error('ожидался шаблон');
    expect(harmony.best.template).toBe('i');
    const e = expectation(analysis, 4);
    const hue = partOf(e, 'hue');
    expect(reasonsOf(e)).toEqual(['hue']);
    expect(hue?.expected).toBeCloseTo(harmony.tiles[4]!.edge, 12);
    expect(hue?.ratio).toBeCloseTo(harmony.tiles[4]!.distance / GRID_TOLERANCE.hue, 12);
    expect(harmony.tiles[4]!.distance).toBeGreaterThan(30);
    // Температура и хрома у неё — как у остальных.
    expect(partOf(e, 'temperature')!.ratio).toBeLessThan(0.01);
    expect(partOf(e, 'chroma')!.ratio).toBeLessThan(0.01);
    // Внутри сектора — 0, ожидание — сам тон.
    const inside = partOf(expectation(analysis, 0), 'hue');
    expect(inside?.ratio).toBe(0);
    expect(inside?.expected).toBe(inside?.value);
    expect(analysis.outliers.map((o) => o.index)).toEqual([4]);
  });

  it('вес хромы: у бледной плитки тот же выход весит меньше, у почти серой — ничего', () => {
    // Средняя хрома пикселей у всех одна: меняется только хрома среднего цвета — точка колеса.
    const full = partOf(expectation(analyze(coldGrid(0.1, 0.1)), 4), 'hue')!;
    const pale = analyze(coldGrid(0.03, 0.1));
    const paleHue = partOf(expectation(pale, 4), 'hue')!;
    const harmony = pale.metrics?.harmony;
    if (harmony?.kind !== 'template') throw new Error('ожидался шаблон');
    const distance = harmony.tiles[4]!.distance;
    expect(distance).toBeGreaterThan(30);
    expect(paleHue.ratio).toBeCloseTo((hueChromaWeight(0.03) * distance) / GRID_TOLERANCE.hue, 12);
    expect(hueChromaWeight(0.03)).toBeCloseTo(0.03 / DEVIATION_HUE_CHROMA, 12);
    expect(paleHue.ratio).toBeLessThan(full.ratio);
    // Хрома среднего ниже порога гармонии: плитка не весит, тон не проверяется, хотя она далеко.
    const gray = analyze(coldGrid(0.008, 0.1));
    expect(partOf(expectation(gray, 4), 'hue')?.ratio).toBe(0);
    expect(expectation(gray, 4).reasons.map((p) => p.reason)).not.toContain('hue');
  });

  it('выход меньше допуска — не выброс, хотя на колесе плитка вне шаблона', () => {
    // Плитка в 23° от остальных: узкий сектор (18°) их не накрывает, она в 5° за краем.
    const tiles = coldGrid(0.1);
    tiles[4] = { L: 0.75, ...ab(COLDEST - 30 + 23, 0.1) };
    const analysis = analyze(tiles);
    const harmony = analysis.metrics?.harmony;
    if (harmony?.kind !== 'template') throw new Error('ожидался шаблон');
    const { distance, outside } = harmony.tiles[4]!;
    expect(outside).toBe(true);
    expect(distance).toBeGreaterThan(HARMONY_EDGE_TOLERANCE);
    expect(distance).toBeLessThan(GRID_TOLERANCE.hue);
    expect(partOf(expectation(analysis, 4), 'hue')?.ratio).toBeCloseTo(distance / GRID_TOLERANCE.hue, 12);
    expect(reasonsOf(expectation(analysis, 4))).not.toContain('hue');
  });

  it('нейтральная сетка — выбросов по тону нет', () => {
    // Серые с лёгким холодным оттенком и одна плитка другого тона: вес мал, сетка нейтральная.
    const tiles: TileSpec[] = Array.from({ length: 9 }, () => ({ L: 0.6, ...ab(240, 0.005) }));
    const [va, vb] = TINT_AXIS;
    tiles[4] = { L: 0.6, a: va * 0.02, b: vb * 0.02, C: 0.005 };
    const analysis = analyze(tiles);
    expect(analysis.metrics?.harmony.kind).toBe('neutral');
    expect(temperature(tiles[4]!.a!, tiles[4]!.b!)).toBeCloseTo(0, 12);
    expect(analysis.expectations.every((e) => !partOf(e, 'hue'))).toBe(true);
    expect(analysis.outliers).toEqual([]);
  });
});

describe('список выбросов', () => {
  it('по величине отклонения, причины — от худшей; опубликованные помечены', () => {
    const tiles: TileSpec[] = checker().map((L) => ({ L }));
    // Тёмная плитка 2 опубликована: хрома — 2.5 допуска, L — светлее остальных тёмных на 0.1.
    tiles[1] = { L: 0.54, C: 2.5 * GRID_TOLERANCE.chroma, published: true };
    // Светлая плитка 7 светлее остальных светлых на 2 допуска.
    tiles[6] = { L: 0.81 + 2 * GRID_TOLERANCE.L };
    const analysis = analyze(tiles);
    expect(analysis.metrics?.rhythm.kind).toBe('pattern');
    const order = analysis.outliers.map((o) => o.index);
    expect(order).toEqual([4, 1, 6]);
    const published = analysis.outliers[1]!;
    expect(published.published).toBe(true);
    expect(reasonsOf(published)).toEqual(['chroma', 'L']);
    expect(published.deviation).toBeCloseTo(2.5, 6);
    expect(analysis.outliers[2]!.deviation).toBeCloseTo(2, 6);
    for (let i = 1; i < order.length; i++) {
      expect(analysis.outliers[i - 1]!.deviation).toBeGreaterThanOrEqual(analysis.outliers[i]!.deviation);
    }
  });

  it('при равном отклонении — по порядку сетки', () => {
    const e = (index: number, deviation: number) => ({ index, deviation, reasons: [{}] }) as unknown as TileExpectation;
    expect(outliersOf([e(5, 2), e(2, 2), e(7, 3), { ...e(1, 0.5), reasons: [] }]).map((o) => o.index)).toEqual([7, 2, 5]);
  });

  it('опубликованная плитка входит в медиану класса других плиток', () => {
    const values = checker([0.82, 0.83, 0.84, 0.85, 0.86]);
    const plain = analyze(values);
    const tiles: TileSpec[] = values.map((L) => ({ L }));
    tiles[4] = { L: 0.6, published: true };
    const withPublished = analyze(tiles);
    // Светлая плитка 1: другие светлые — 0.83, 0.84 (или опубликованная 0.6), 0.85, 0.86.
    expect(partOf(expectation(plain, 0), 'L')?.expected).toBeCloseTo(0.845, 12);
    expect(partOf(expectation(withPublished, 0), 'L')?.expected).toBeCloseTo(0.84, 12);
    expect(withPublished.outliers.map((o) => [o.index, o.published])).toEqual([[4, true]]);
  });
});

describe('пропуски', () => {
  it('пустые позиции и плитки без признаков ожидания не получают и в медианы не входят', () => {
    const { project, byId } = grid([0.8, 0.4, 0.82, null, 0.84, 0.42, 0.86, 0.44, 0.88]);
    delete byId['s8'];
    const analysis = analyzeGrid(project, byId);
    expect(analysis.expectations.map((e) => e.index)).toEqual([0, 1, 2, 4, 5, 6, 7]);
  });
});
