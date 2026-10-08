// Гармония сетки по тоновым шаблонам Мацуды (docs/spec.md, «Гармония»; docs/decisions/0019-harmony.md).
// Шаблон — набор секторов на круге тонов OKLCH; ширины — из Cohen-Or et al., «Color Harmonization» (2006).
// Плитка — точка с тоном и хромой своего среднего цвета (features.ts), вес — хрома сверх порога.
// Шаблон поворачивается так, чтобы взвешенный выход тонов за сектора был наименьшим; лучший шаблон —
// с наименьшей суммой остатка и штрафа за ширину секторов. Самые далёкие плитки с малой долей веса
// в выбор не входят: одна плитка чужого тона не расширяет шаблон, а остаётся вне его (выброс, 4в).
// Производные данные: в проект и историю не попадают.
import { hueDistance } from '../color/math';

export type HarmonyTemplateId = 'i' | 'V' | 'L' | 'I' | 'T' | 'Y' | 'X';

/** Сектор шаблона относительно его угла: смещение центра и ширина, градусы. */
export interface SectorShape {
  offset: number;
  width: number;
}

/** Сектор на круге: центр 0..360 и ширина, градусы. */
export interface Sector {
  center: number;
  width: number;
}

/** Узкий сектор (i, I, акценты L и Y). */
export const NARROW_SECTOR = 18;
/** Широкий сектор (V, Y, X). */
export const WIDE_SECTOR = 93.6;
/** Главный сектор L. */
export const L_SECTOR = 79.2;

/**
 * Шаблоны Мацуды с ширинами Cohen-Or 2006. Первый сектор — главный: угол шаблона — его центр.
 * L — главный тон и акцент под прямым углом; зеркальный L (акцент по часовой) — тот же шаблон, `mirrored`.
 */
export const HARMONY_TEMPLATES: Readonly<Record<HarmonyTemplateId, readonly SectorShape[]>> = {
  i: [{ offset: 0, width: NARROW_SECTOR }],
  V: [{ offset: 0, width: WIDE_SECTOR }],
  L: [
    { offset: 0, width: L_SECTOR },
    { offset: 90, width: NARROW_SECTOR },
  ],
  I: [
    { offset: 0, width: NARROW_SECTOR },
    { offset: 180, width: NARROW_SECTOR },
  ],
  T: [{ offset: 0, width: 180 }],
  Y: [
    { offset: 0, width: WIDE_SECTOR },
    { offset: 180, width: NARROW_SECTOR },
  ],
  X: [
    { offset: 0, width: WIDE_SECTOR },
    { offset: 180, width: WIDE_SECTOR },
  ],
};

/** Порядок перебора — как в спеке; при равной цене выигрывает более узкий, затем — раньше в списке. */
export const HARMONY_ORDER: readonly HarmonyTemplateId[] = ['i', 'V', 'L', 'I', 'T', 'Y', 'X'];

export const HARMONY_LABELS: Record<HarmonyTemplateId, string> = {
  i: 'Один тон',
  V: 'Аналоговая',
  L: 'Тон и акцент под прямым углом',
  I: 'Два противоположных тона',
  T: 'Половина круга',
  Y: 'Тон и противоположный акцент',
  X: 'Две противоположные группы',
};

/** Хрома среднего цвета, ниже которой плитка не весит: тон почти серого кадра — шум. */
export const HUE_WEIGHT_FLOOR = 0.01;
/** Средний вес плиток ниже этого — «нейтральная сетка»: без шаблона и выбросов по тону. */
export const NEUTRAL_GRID_WEIGHT = 0.01;
/**
 * Доля веса самых далёких от секторов плиток, которая не входит в выбор угла и шаблона. Одна плитка из 6–9
 * чужого тона в неё укладывается и остаётся выбросом; две из 9 и треть сетки — уже часть схемы.
 */
export const HARMONY_OUTLIER_SHARE = 0.2;
/** Штраф за ширину: градусов остатка за градус суммарной ширины секторов. */
export const HARMONY_WIDTH_PENALTY = 0.01;
/** Плитка дальше этого от секторов, градусы, — «вне шаблона»: меньшие выходы — шум декодера и сжатия. */
export const HARMONY_EDGE_TOLERANCE = 1;

/** Шаг перебора угла и шаг уточнения вокруг лучшего, градусы. */
const COARSE_STEP = 1;
const FINE_STEP = 0.1;
/** Равенство остатков при сравнении углов и шаблонов. */
const EPS = 1e-9;

export interface HuePoint {
  /** Тон среднего цвета, градусы. */
  hue: number;
  /** Хрома среднего цвета. */
  chroma: number;
}

export interface HarmonyFit {
  template: HarmonyTemplateId;
  /** Угол шаблона — центр главного сектора, градусы 0..360; у I и X (симметричных) — 0..180. */
  angle: number;
  /** Только L: акцент на 90° по часовой стрелке, а не против. */
  mirrored: boolean;
  sectors: Sector[];
  /** Оценка: средний выход тонов за сектора, взвешенный хромой, градусы. Внутри секторов — 0. */
  score: number;
  /** То же без самых далёких плиток с долей веса HARMONY_OUTLIER_SHARE: по нему выбираются угол и шаблон. */
  trimmed: number;
  /** trimmed + HARMONY_WIDTH_PENALTY · суммарная ширина секторов. */
  cost: number;
}

export interface TileHue {
  /** Вес плитки в гармонии: хрома сверх HUE_WEIGHT_FLOOR. */
  weight: number;
  /** Градусов до ближайшего сектора; 0 — внутри. */
  distance: number;
  /** Вне шаблона: плитка весит и выходит за сектора больше HARMONY_EDGE_TOLERANCE. */
  outside: boolean;
  /** Тон ближайшего края ближайшего сектора. */
  edge: number;
}

export type Harmony =
  | { kind: 'neutral'; meanWeight: number }
  | {
      kind: 'template';
      meanWeight: number;
      best: HarmonyFit;
      /** Лучшая посадка каждого шаблона, в порядке HARMONY_ORDER. */
      fits: HarmonyFit[];
      /** Положение каждой точки относительно секторов лучшего шаблона, в порядке входа. */
      tiles: TileHue[];
    };

/** Вес плитки: хрома среднего цвета сверх порога. Серые плитки любого тона не весят. */
export function hueWeight(chroma: number): number {
  return Math.max(0, chroma - HUE_WEIGHT_FLOOR);
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Суммарная ширина секторов шаблона, градусы. */
export function templateWidth(template: HarmonyTemplateId): number {
  return HARMONY_TEMPLATES[template].reduce((sum, sector) => sum + sector.width, 0);
}

/** Период поворота: I и X переходят в себя при повороте на 180°. */
function templatePeriod(template: HarmonyTemplateId): number {
  return template === 'I' || template === 'X' ? 180 : 360;
}

/** Сектора шаблона, повёрнутого на angle; mirrored — зеркальный L. */
export function templateSectors(template: HarmonyTemplateId, angle: number, mirrored = false): Sector[] {
  return HARMONY_TEMPLATES[template].map(({ offset, width }) => ({ center: wrap(angle + (mirrored ? -offset : offset)), width }));
}

/** Градусов от тона до сектора; 0 — внутри или на краю. */
export function sectorDistance(hue: number, sector: Sector): number {
  return Math.max(0, hueDistance(hue, sector.center) - sector.width / 2);
}

/** Положение тона относительно секторов: расстояние до ближайшего, его номер и ближайший край. */
export function locateHue(hue: number, sectors: readonly Sector[]): { distance: number; sector: number; edge: number } {
  let best = { distance: Infinity, sector: -1, edge: 0 };
  sectors.forEach((sector, index) => {
    const distance = sectorDistance(hue, sector);
    if (distance >= best.distance) return;
    // Край со стороны тона: знак кратчайшей разности тона и центра.
    const signed = ((wrap(hue - sector.center) + 180) % 360) - 180;
    best = { distance, sector: index, edge: wrap(sector.center + (signed >= 0 ? 1 : -1) * (sector.width / 2)) };
  });
  return best;
}

interface Weighted {
  hue: number;
  weight: number;
}

/**
 * Остатки посадки: без самых далёких плиток, полный и разброс тонов вокруг центров секторов (для равных углов).
 * distances — рабочий массив на число точек.
 */
function evaluate(points: readonly Weighted[], sectors: readonly Sector[], total: number, distances: Float64Array): [number, number, number] {
  let full = 0;
  let spread = 0;
  for (let i = 0; i < points.length; i++) {
    const { hue, weight } = points[i] as Weighted;
    let distance = Infinity;
    let toCenter = Infinity;
    for (const { center, width } of sectors) {
      const d = hueDistance(hue, center);
      distance = Math.min(distance, Math.max(0, d - width / 2));
      toCenter = Math.min(toCenter, d);
    }
    distances[i] = distance;
    full += weight * distance;
    spread += weight * toCenter * toCenter;
  }
  // Самые далёкие плитки с долей веса HARMONY_OUTLIER_SHARE в остаток выбора не входят; граничная — частью веса.
  // Их немного, поэтому — выбором самой далёкой, а не сортировкой.
  let budget = HARMONY_OUTLIER_SHARE * total;
  let dropped = 0;
  while (budget > 0 && dropped < full) {
    let far = -1;
    let farDistance = 0;
    for (let i = 0; i < points.length; i++) {
      const d = distances[i] as number;
      if (d > farDistance) {
        far = i;
        farDistance = d;
      }
    }
    if (far < 0) break;
    const weight = Math.min((points[far] as Weighted).weight, budget);
    budget -= weight;
    dropped += weight * farDistance;
    distances[far] = 0;
  }
  return [Math.max(0, full - dropped) / total, full / total, spread / total];
}

/** Лексикографически: остаток выбора, полный остаток, разброс вокруг центров. */
function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d < -EPS) return true;
    if (d > EPS) return false;
  }
  return false;
}

/**
 * Лучший угол шаблона: перебор через 1°, затем уточнение до 0.1° вокруг лучшего. Угол — тот, при котором
 * наименьший остаток без далёких плиток; среди равных — наименьший полный остаток (так по Cohen-Or),
 * затем — тона ближе всего к центрам секторов.
 */
export function fitTemplate(points: readonly HuePoint[], template: HarmonyTemplateId, mirrored = false): HarmonyFit {
  const weighted = points.map(({ hue, chroma }) => ({ hue, weight: hueWeight(chroma) })).filter((p) => p.weight > 0);
  const total = weighted.reduce((sum, p) => sum + p.weight, 0);
  const period = templatePeriod(template);
  const distances = new Float64Array(weighted.length);
  const score = (angle: number): [number, number, number] =>
    total > 0 ? evaluate(weighted, templateSectors(template, angle, mirrored), total, distances) : [0, 0, 0];

  let bestAngle = 0;
  let best = score(0);
  for (let angle = COARSE_STEP; angle < period; angle += COARSE_STEP) {
    const value = score(angle);
    if (better(value, best)) [bestAngle, best] = [angle, value];
  }
  const coarse = bestAngle;
  const steps = Math.round(COARSE_STEP / FINE_STEP);
  for (let k = -steps; k <= steps; k++) {
    if (k === 0) continue;
    const angle = coarse + k * FINE_STEP;
    const value = score(angle);
    if (better(value, best)) [bestAngle, best] = [angle, value];
  }
  // Угол — с точностью уточнения (0.1°), в пределах периода: −0.1 и 359.9 — один и тот же поворот.
  const rounded = Math.round(bestAngle * 10) / 10;
  const angle = rounded < 0 ? rounded + period : rounded >= period ? rounded - period : rounded;
  const [trimmed, full] = score(angle);
  return {
    template,
    angle,
    mirrored,
    sectors: templateSectors(template, angle, mirrored),
    score: full,
    trimmed,
    cost: trimmed + HARMONY_WIDTH_PENALTY * templateWidth(template),
  };
}

/**
 * Гармония сетки по точкам колеса (тон и хрома среднего цвета плиток). Средний вес меньше
 * NEUTRAL_GRID_WEIGHT — нейтральная сетка: шаблона нет. Иначе — лучший шаблон по цене «остаток без далёких
 * плиток + штраф за ширину», его оценка — полный остаток и положение каждой точки относительно секторов.
 */
export function fitHarmony(points: readonly HuePoint[]): Harmony {
  const weights = points.map((p) => hueWeight(p.chroma));
  const meanWeight = points.length === 0 ? 0 : weights.reduce((sum, w) => sum + w, 0) / points.length;
  if (meanWeight < NEUTRAL_GRID_WEIGHT) return { kind: 'neutral', meanWeight };

  const fits = HARMONY_ORDER.map((template) => {
    const fit = fitTemplate(points, template);
    if (template !== 'L') return fit;
    const mirrored = fitTemplate(points, template, true);
    return better([mirrored.trimmed, mirrored.score], [fit.trimmed, fit.score]) ? mirrored : fit;
  });
  let best = fits[0] as HarmonyFit;
  for (const fit of fits) {
    const d = fit.cost - best.cost;
    if (d < -EPS || (Math.abs(d) <= EPS && templateWidth(fit.template) < templateWidth(best.template))) best = fit;
  }
  const tiles = points.map(({ hue }, i): TileHue => {
    const weight = weights[i] as number;
    const { distance, edge } = locateHue(hue, best.sectors);
    return { weight, distance, outside: weight > 0 && distance > HARMONY_EDGE_TOLERANCE, edge };
  });
  return { kind: 'template', meanWeight, best, fits, tiles };
}
