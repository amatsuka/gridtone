import { describe, expect, it } from 'vitest';
import { hueDistance } from '@core/color/math';
import {
  fitHarmony,
  fitTemplate,
  HARMONY_EDGE_TOLERANCE,
  HARMONY_ORDER,
  HARMONY_TEMPLATES,
  HUE_WEIGHT_FLOOR,
  hueWeight,
  L_SECTOR,
  locateHue,
  NARROW_SECTOR,
  NEUTRAL_GRID_WEIGHT,
  sectorDistance,
  templateSectors,
  templateWidth,
  WIDE_SECTOR,
  type Harmony,
  type HarmonyTemplateId,
  type HuePoint,
} from '@core/harmony/templates';
import { seededRandom } from '../color/helpers';

const point = (hue: number, chroma = 0.1): HuePoint => ({ hue: ((hue % 360) + 360) % 360, chroma });
const points = (hues: readonly number[], chroma = 0.1) => hues.map((hue) => point(hue, chroma));

function templateOf(harmony: Harmony): Extract<Harmony, { kind: 'template' }> {
  if (harmony.kind !== 'template') throw new Error('ожидался шаблон, а сетка нейтральная');
  return harmony;
}

/** Разность углов шаблона с учётом периода: у I и X угол определён с точностью до 180°. */
function angleError(template: HarmonyTemplateId, a: number, b: number): number {
  const period = template === 'I' || template === 'X' ? 180 : 360;
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

/** Тона, заполняющие сектора от края до края (на 0.5° внутрь), и центры секторов. */
function fillSectors(template: HarmonyTemplateId, angle: number, mirrored = false): number[] {
  return templateSectors(template, angle, mirrored).flatMap(({ center, width }) => {
    const half = width / 2 - 0.5;
    return [center - half, center - half / 2, center, center + half / 2, center + half];
  });
}

describe('геометрия шаблонов', () => {
  it('ширины и положения секторов — Cohen-Or 2006', () => {
    expect(NARROW_SECTOR).toBe(18);
    expect(WIDE_SECTOR).toBe(93.6);
    expect(L_SECTOR).toBe(79.2);
    expect(HARMONY_ORDER).toEqual(['i', 'V', 'L', 'I', 'T', 'Y', 'X']);
    const shapes = Object.fromEntries(
      HARMONY_ORDER.map((id) => [id, HARMONY_TEMPLATES[id].map(({ offset, width }) => [offset, width])]),
    );
    expect(shapes).toEqual({
      i: [[0, 18]],
      V: [[0, 93.6]],
      L: [
        [0, 79.2],
        [90, 18],
      ],
      I: [
        [0, 18],
        [180, 18],
      ],
      T: [[0, 180]],
      Y: [
        [0, 93.6],
        [180, 18],
      ],
      X: [
        [0, 93.6],
        [180, 93.6],
      ],
    });
    expect(HARMONY_ORDER.map(templateWidth)).toEqual([18, 93.6, 97.2, 36, 180, 111.6, 187.2]);
  });

  it('поворот и зеркальный L; центры в 0..360', () => {
    expect(templateSectors('Y', 300)).toEqual([
      { center: 300, width: 93.6 },
      { center: 120, width: 18 },
    ]);
    expect(templateSectors('L', 30).map((s) => s.center)).toEqual([30, 120]);
    expect(templateSectors('L', 30, true).map((s) => s.center)).toEqual([30, 300]);
    expect(templateSectors('i', -10)[0]?.center).toBe(350);
  });

  it('расстояние до ближайшего края: внутри и на краю 0, снаружи — градусы за краем', () => {
    const sector = { center: 100, width: 18 };
    expect(sectorDistance(100, sector)).toBe(0);
    expect(sectorDistance(109, sector)).toBe(0);
    expect(sectorDistance(91, sector)).toBe(0);
    expect(sectorDistance(120, sector)).toBeCloseTo(11, 12);
    expect(sectorDistance(80, sector)).toBeCloseTo(11, 12);
    // Противоположный тон — дальше всего: 180 − 9.
    expect(sectorDistance(280, sector)).toBeCloseTo(171, 12);

    const sectors = templateSectors('I', 0);
    expect(locateHue(30, sectors)).toEqual({ distance: 21, sector: 0, edge: 9 });
    expect(locateHue(150, sectors)).toEqual({ distance: 21, sector: 1, edge: 171 });
    expect(locateHue(185, sectors)).toEqual({ distance: 0, sector: 1, edge: 189 });
  });

  it('переход через 0°/360°', () => {
    const sector = { center: 355, width: 18 };
    expect(sectorDistance(3, sector)).toBe(0);
    expect(sectorDistance(10, sector)).toBeCloseTo(6, 12);
    expect(sectorDistance(340, sector)).toBeCloseTo(6, 12);
    const located = locateHue(10, [sector]);
    expect(located.distance).toBeCloseTo(6, 12);
    expect(located.edge).toBeCloseTo(4, 12);
    expect(locateHue(340, [sector]).edge).toBeCloseTo(346, 12);
    // Шаблон, повёрнутый через ноль, накрывает тона по обе стороны от него.
    const fit = fitTemplate(points([352, 355, 0, 3, 7]), 'i');
    expect(fit.score).toBe(0);
    expect(hueDistance(fit.angle, 0)).toBeLessThanOrEqual(1);
  });
});

describe('подбор угла', () => {
  it('тона внутри повёрнутого шаблона: нулевой остаток и тот же угол (±1°)', () => {
    for (const template of HARMONY_ORDER) {
      for (const angle of [0, 37.5, 133, 251.3, 359]) {
        const fit = fitTemplate(points(fillSectors(template, angle)), template);
        expect(fit.score, `${template} @ ${angle}`).toBe(0);
        expect(fit.trimmed).toBe(0);
        expect(angleError(template, fit.angle, angle), `${template} @ ${angle}: ${fit.angle}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('зеркальный L узнаётся с флагом mirrored', () => {
    const harmony = templateOf(fitHarmony(points(fillSectors('L', 200, true))));
    expect(harmony.best.template).toBe('L');
    expect(harmony.best.mirrored).toBe(true);
    expect(harmony.best.score).toBe(0);
    expect(angleError('L', harmony.best.angle, 200)).toBeLessThanOrEqual(1);
  });

  it('поворот всех тонов поворачивает угол и не меняет остаток', () => {
    const random = seededRandom(7);
    for (let trial = 0; trial < 12; trial++) {
      const hues = Array.from({ length: 9 }, () => random() * 360);
      const chromas = hues.map(() => 0.03 + random() * 0.12);
      const base = templateOf(fitHarmony(hues.map((h, i) => point(h, chromas[i]))));
      for (const shift of [90, 123.4, 271.7]) {
        const turned = templateOf(fitHarmony(hues.map((h, i) => point(h + shift, chromas[i]))));
        expect(turned.best.template, `проба ${trial}, сдвиг ${shift}`).toBe(base.best.template);
        expect(angleError(base.best.template, turned.best.angle, base.best.angle + shift)).toBeLessThanOrEqual(1);
        expect(Math.abs(turned.best.score - base.best.score)).toBeLessThan(0.1);
      }
    }
  });

  it('оценка — средний выход за сектора с весом хромы', () => {
    // i накрывает 0..18 из тонов 0, 0, 30: третий за краем на 12° при угле 9 — ближе нельзя, не выпустив первые.
    const fit = fitTemplate([point(0, 0.11), point(0, 0.11), point(30, 0.21)], 'i');
    const w = hueWeight(0.11);
    const far = hueWeight(0.21);
    expect(fit.angle).toBeCloseTo(9, 6);
    expect(fit.score).toBeCloseTo((far * 12) / (2 * w + far), 6);
  });
});

describe('выбор шаблона', () => {
  const best = (hs: HuePoint[]) => templateOf(fitHarmony(hs)).best;

  it('один тон — i, а не X', () => {
    expect(best(points([200, 202, 198, 201, 199, 200, 203, 197, 200])).template).toBe('i');
    // У всех шаблонов остаток 0, выбирает штраф за ширину.
    expect(templateOf(fitHarmony(points(Array(9).fill(120)))).fits.every((fit) => fit.score === 0)).toBe(true);
  });

  it('два противоположных тона — I', () => {
    const fit = best(points([30, 32, 28, 31, 29, 210, 212, 208, 211]));
    expect(fit.template).toBe('I');
    expect(fit.score).toBe(0);
  });

  it('половина круга — T', () => {
    for (const count of [9, 19, 37]) {
      const fit = best(points(Array.from({ length: count }, (_, i) => 20 + (180 * i) / (count - 1))));
      expect(fit.template, `${count} тонов`).toBe('T');
      expect(fit.score).toBe(0);
    }
  });

  it('аналоговая сетка с одной плиткой чужого тона — V, плитка вне секторов', () => {
    const analog = [40, 47, 54, 61, 68, 75, 82, 90];
    for (const foreign of [140, 155, 200, 250, 300]) {
      const harmony = templateOf(fitHarmony(points([...analog, foreign])));
      expect(harmony.best.template, `чужой тон ${foreign}°`).toBe('V');
      expect(harmony.tiles.map((t) => t.outside)).toEqual([...analog.map(() => false), true]);
      expect(harmony.best.score).toBeGreaterThan(0);
    }
    // На 6 плитках одна чужая — тоже выброс, а не второй сектор.
    const six = templateOf(fitHarmony(points([50, 60, 70, 80, 90, 230])));
    expect(six.best.template).toBe('V');
    expect(six.tiles.at(-1)?.outside).toBe(true);
  });

  it('два-три акцента уже входят в схему', () => {
    const analog = [40, 47, 54, 61, 68, 75, 90];
    expect(best(points([...analog, 155, 159])).template).toBe('L');
    expect(best(points([...analog, 245, 249])).template).toBe('Y');
    for (const fit of [best(points([...analog, 155, 159])), best(points([...analog, 245, 249]))]) expect(fit.score).toBe(0);
  });

  it('треть сетки в противоположном тоне — шаблон с двумя секторами', () => {
    const fit = best(points([60, 64, 66, 70, 62, 68, 240, 245, 250]));
    expect(HARMONY_TEMPLATES[fit.template]).toHaveLength(2);
    expect(fit.score).toBe(0);
    // Аналоговая группа шире узкого сектора — главный сектор широкий, акцент узкий.
    expect(best(points([40, 55, 70, 85, 50, 75, 240, 245, 250])).template).toBe('Y');
  });

  it('положение плиток — относительно секторов лучшего шаблона', () => {
    const harmony = templateOf(fitHarmony(points([55, 60, 65, 235, 240, 145])));
    expect(harmony.best.template).toBe('I');
    const green = harmony.tiles[5]!;
    expect(green.outside).toBe(true);
    expect(green.distance).toBeGreaterThan(60);
    expect(green.distance).toBeCloseTo(locateHue(145, harmony.best.sectors).distance, 12);
    expect(harmony.tiles.slice(0, 5).every((t) => !t.outside && t.distance <= HARMONY_EDGE_TOLERANCE)).toBe(true);
    // Оценка — весь выход, вместе с выбросом; выбор шаблона — без него.
    expect(harmony.best.score).toBeCloseTo(green.distance / 6, 6);
    expect(harmony.best.trimmed).toBe(0);
  });
});

describe('вес хромы и нейтральная сетка', () => {
  it('вес — хрома сверх порога', () => {
    expect(hueWeight(0)).toBe(0);
    expect(hueWeight(HUE_WEIGHT_FLOOR)).toBe(0);
    expect(hueWeight(0.1)).toBeCloseTo(0.1 - HUE_WEIGHT_FLOOR, 12);
  });

  it('серые плитки любого тона результат не меняют', () => {
    const colored = points([55, 60, 65, 235, 240, 238, 58]);
    const base = templateOf(fitHarmony(colored));
    for (const hue of [0, 90, 145, 300]) {
      const harmony = templateOf(fitHarmony([...colored, point(hue, 0.005), point(hue + 40, HUE_WEIGHT_FLOOR)]));
      expect(harmony.best).toEqual(base.best);
      expect(harmony.tiles.slice(-2).map((t) => [t.weight, t.outside])).toEqual([
        [0, false],
        [0, false],
      ]);
    }
  });

  it('насыщенность плитки вне шаблона в ноль — остаток почти ноль', () => {
    const outside = templateOf(fitHarmony(points([55, 60, 65, 235, 240, 145])));
    const faded = templateOf(fitHarmony([...points([55, 60, 65, 235, 240]), point(145, 0.004)]));
    expect(outside.best.score).toBeGreaterThan(5);
    expect(faded.best.template).toBe('I');
    expect(faded.best.score).toBe(0);
  });

  it('порог нейтральной сетки — средний вес плиток', () => {
    // Серые с лёгким оттенком: хрома 0.005–0.015 — нейтральная.
    const tinted = [0.005, 0.012, 0.008, 0.015, 0.01, 0.006].map((c, i) => point(i * 60, c));
    expect(fitHarmony(tinted)).toEqual({ kind: 'neutral', meanWeight: expect.closeTo(0.007 / 6, 9) });
    // Средний вес чуть ниже порога — нейтральная, чуть выше — шаблон.
    const chroma = (weight: number) => weight + HUE_WEIGHT_FLOOR;
    expect(fitHarmony(points([10, 20, 30, 200, 210, 220], chroma(NEUTRAL_GRID_WEIGHT * 0.99))).kind).toBe('neutral');
    expect(fitHarmony(points([10, 20, 30, 200, 210, 220], chroma(NEUTRAL_GRID_WEIGHT * 1.01))).kind).toBe('template');
    // Одна яркая плитка среди серых держит средний вес выше порога: шаблон i вокруг неё.
    const accent = templateOf(fitHarmony([...points([0, 60, 120, 180, 240, 300, 90, 270], 0.004), point(30, 0.2)]));
    expect(accent.best.template).toBe('i');
    expect(accent.tiles.every((t) => !t.outside)).toBe(true);
    expect(fitHarmony([]).kind).toBe('neutral');
  });
});
