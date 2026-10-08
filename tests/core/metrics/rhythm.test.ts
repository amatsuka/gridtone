import { describe, expect, it } from 'vitest';
import {
  detectRhythm,
  FLAT_SPREAD,
  MIN_GRID_TILES,
  RHYTHM_MIN_STRENGTH,
  RHYTHM_TEMPLATES,
  spreadOf,
  templateClass,
  type Rhythm,
  type RhythmTemplate,
} from '@core/metrics/rhythm';
import { seededRandom } from '../color/helpers';

const COLUMNS = 3;

/** Классы шаблона на сетке 3 × rows строкой: «010/101/010». */
function layout(template: Exclude<RhythmTemplate, 'gradient'>, rows: number): string {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: COLUMNS }, (_, c) => templateClass(template, r * COLUMNS + c, COLUMNS)).join(''),
  ).join('/');
}

/** Карта по шаблону: уровень класса плюс шум ±noise/2. */
function map(template: RhythmTemplate, count: number, noise: number, seed: number): number[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const base =
      template === 'gradient'
        ? 0.85 - (0.5 * i) / (count - 1)
        : ([0.3, 0.75, 0.52][templateClass(template, i, COLUMNS)] as number);
    return base + (random() - 0.5) * noise;
  });
}

function best(rhythm: Rhythm | null): { kind: Rhythm['kind']; template: RhythmTemplate | undefined; strength: number } {
  if (!rhythm) throw new Error('ритма нет');
  return rhythm.kind === 'flat'
    ? { kind: 'flat', template: undefined, strength: 0 }
    : { kind: rhythm.kind, template: rhythm.best.template, strength: rhythm.best.strength };
}

describe('шаблоны ритма на трёх колонках', () => {
  it('раскладка классов', () => {
    expect(layout('checker', 3)).toBe('010/101/010');
    expect(layout('rows', 4)).toBe('000/111/000/111');
    expect(layout('columns', 2)).toBe('012/012');
    expect(layout('diagonal', 3)).toBe('012/201/120');
    expect(layout('antidiagonal', 3)).toBe('012/120/201');
  });

  it('шахматка на трёх колонках — чередование по позиции: переживает сдвиг ленты на один пост', () => {
    for (let i = 0; i < 30; i++) expect(templateClass('checker', i, COLUMNS)).toBe(i % 2);
  });
});

describe('распознанный ритм', () => {
  it.each(RHYTHM_TEMPLATES.map((t) => [t]))('%s узнаётся на своей карте с шумом', (template) => {
    for (const count of [9, 18, 30]) {
      const result = best(detectRhythm(map(template, count, 0.08, count), COLUMNS));
      expect(result.kind, `${count} плиток`).toBe('pattern');
      expect(result.template, `${count} плиток`).toBe(template);
      expect(result.strength).toBeGreaterThan(0.8);
    }
  });

  it('без шума сила 1, у остальных шаблонов меньше', () => {
    const rhythm = detectRhythm(map('checker', 12, 0, 1), COLUMNS);
    expect(best(rhythm)).toEqual({ kind: 'pattern', template: 'checker', strength: 1 });
    if (rhythm?.kind !== 'pattern') throw new Error('ожидалась шахматка');
    for (const fit of rhythm.fits) if (fit.template !== 'checker') expect(fit.strength).toBeLessThan(0.5);
  });

  it('случайная карта не узнаётся', () => {
    const random = seededRandom(42);
    const values = Array.from({ length: 30 }, () => 0.3 + random() * 0.5);
    const result = best(detectRhythm(values, COLUMNS));
    expect(result.kind).toBe('none');
    expect(result.strength).toBeLessThan(RHYTHM_MIN_STRENGTH);
  });

  it('ложные срабатывания на случайных картах: 18 плиток — меньше 3%, 30 — почти никогда', () => {
    const rate = (count: number, trials: number) => {
      const random = seededRandom(count);
      let hits = 0;
      for (let k = 0; k < trials; k++) {
        const values = Array.from({ length: count }, () => 0.3 + random() * 0.5);
        if (detectRhythm(values, COLUMNS)?.kind === 'pattern') hits++;
      }
      return hits / trials;
    };
    expect(rate(18, 1000)).toBeLessThan(0.03);
    expect(rate(30, 1000)).toBeLessThan(0.005);
  });

  it('шахматка из 9 с одной плиткой не на своём месте ещё узнаётся: так её найдут выбросы', () => {
    const values = [0.8, 0.4, 0.8, 0.4, 0.4, 0.4, 0.8, 0.4, 0.8];
    const result = best(detectRhythm(values, COLUMNS));
    expect(result).toMatchObject({ kind: 'pattern', template: 'checker' });
    expect(result.strength).toBeLessThan(0.7);
  });

  it('«ровная»: разброс L ниже порога', () => {
    const random = seededRandom(3);
    const values = Array.from({ length: 12 }, () => 0.6 + (random() - 0.5) * 0.04);
    expect(spreadOf(values)).toBeLessThan(FLAT_SPREAD);
    const rhythm = detectRhythm(values, COLUMNS);
    expect(rhythm?.kind).toBe('flat');
    expect(rhythm?.spread).toBeCloseTo(spreadOf(values), 12);
    // Та же карта, растянутая вчетверо, — уже не ровная.
    expect(detectRhythm(values.map((v) => 0.6 + (v - 0.6) * 4), COLUMNS)?.kind).not.toBe('flat');
  });

  it('знак градиента: «новые светлее» — перепад к началу сетки больше нуля', () => {
    // Позиция 0 — новейший пост.
    const newerLighter = detectRhythm(map('gradient', 12, 0.02, 7), COLUMNS);
    const newerDarker = detectRhythm(map('gradient', 12, 0.02, 7).reverse(), COLUMNS);
    if (newerLighter?.kind !== 'pattern' || newerDarker?.kind !== 'pattern') throw new Error('ожидался градиент');
    expect(newerLighter.best.template).toBe('gradient');
    expect(newerLighter.best.slope).toBeGreaterThan(0);
    expect(newerLighter.best.slope).toBeCloseTo(0.5 / 11, 2);
    expect(newerDarker.best.slope).toBeLessThan(0);
  });

  it('меньше 6 плиток с L — анализа нет; пропуски не считаются', () => {
    expect(detectRhythm([0.3, 0.7, 0.3, 0.7, 0.3], COLUMNS)).toBeNull();
    expect(detectRhythm([0.3, null, 0.3, 0.7, null, 0.7, 0.3, null], COLUMNS)).toBeNull();
    expect(MIN_GRID_TILES).toBe(6);
  });

  it('пропуски не ломают шаблон: шахматка из 15 позиций с тремя пустыми', () => {
    const values: (number | null)[] = map('checker', 15, 0.04, 5);
    values[1] = null;
    values[7] = null;
    values[12] = null;
    expect(best(detectRhythm(values, COLUMNS))).toMatchObject({ kind: 'pattern', template: 'checker' });
  });

  it('скорректированный R²: шаблон с тремя классами не выигрывает у двух классов на шуме', () => {
    // Два уровня шахматкой с заметным шумом: у шаблонов с тремя классами R² бывает выше случайно,
    // но поправка на число классов оставляет первой шахматку.
    for (let seed = 1; seed <= 20; seed++) {
      const rhythm = detectRhythm(map('checker', 18, 0.25, seed), COLUMNS);
      if (rhythm?.kind === 'flat' || !rhythm) throw new Error('не ровная');
      expect(rhythm.best.template, `зерно ${seed}`).toBe('checker');
    }
  });
});
