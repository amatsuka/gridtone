// Палитра плитки (docs/spec.md, «Метрики плитки», «Доминанты») и средние по окну сетки.
// k-means на PALETTE_SIZE кластеров в OKLab, вес пикселя растёт с хромой: серый фон не перевешивает
// цветной объект. Старт детерминирован (k-means++ с постоянным зерном), поэтому одно и то же окно
// всегда даёт одну и ту же палитру — и в воркере, и в тестах. Модель — docs/decisions/0012-view-modes.md.
import type { Vec3 } from '../project/types';

export interface PaletteEntry {
  lab: Vec3;
  /** Доля веса пикселей кластера, в сумме по палитре 1. */
  share: number;
}

export interface LabStats {
  meanL: number;
  meanA: number;
  meanB: number;
  /** Среднее хром пикселей. */
  meanC: number;
  /** Тон среднего цвета, градусы 0..360; у серого 0. */
  hue: number;
}

/** Цветов в палитре — не больше. */
export const PALETTE_SIZE = 5;
/** Вес пикселя — 1 + PALETTE_CHROMA_WEIGHT · C: насыщенный цвет (C ≈ 0.25) весит втрое больше серого. */
export const PALETTE_CHROMA_WEIGHT = 10;
/** Кластеры ближе этого расстояния в OKLab (около порога различимости) сливаются в один цвет. */
export const PALETTE_MERGE_DISTANCE = 0.02;

const MAX_ITERATIONS = 30;
const SEED = 0x2f6b9d1;

export function pixelWeight(chroma: number): number {
  return 1 + PALETTE_CHROMA_WEIGHT * chroma;
}

/** labs — пиксели OKLab подряд (L, a, b). Палитра по убыванию доли. */
export function palette(labs: Float32Array | Float64Array, k = PALETTE_SIZE): PaletteEntry[] {
  const n = Math.floor(labs.length / 3);
  if (n === 0) return [];
  const weights = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = pixelWeight(Math.hypot(labs[i * 3 + 1] as number, labs[i * 3 + 2] as number));
    weights[i] = w;
    total += w;
  }

  const centers = seedCenters(labs, weights, total, k);
  const assignment = new Int32Array(n).fill(-1);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nearest = nearestCenter(labs, i, centers);
      if (nearest !== assignment[i]) {
        assignment[i] = nearest;
        changed = true;
      }
    }
    if (!changed) break;
    const clusters = accumulate(labs, weights, assignment, centers.length);
    clusters.forEach((cluster, c) => {
      // Пустой кластер оставляет прежний центр; в палитру он не попадёт.
      if (cluster.weight > 0) centers[c] = centroid(cluster);
    });
  }

  const clusters = mergeClose(accumulate(labs, weights, assignment, centers.length).filter((c) => c.weight > 0));
  return clusters
    .map((cluster) => ({ lab: centroid(cluster), share: cluster.weight / total }))
    .sort((a, b) => b.share - a.share);
}

/** Средние по пикселям без весов. */
export function labStats(labs: Float32Array | Float64Array): LabStats {
  const n = Math.floor(labs.length / 3);
  let L = 0;
  let a = 0;
  let b = 0;
  let C = 0;
  for (let i = 0; i < n; i++) {
    const pa = labs[i * 3 + 1] as number;
    const pb = labs[i * 3 + 2] as number;
    L += labs[i * 3] as number;
    a += pa;
    b += pb;
    C += Math.hypot(pa, pb);
  }
  if (n === 0) return { meanL: 0, meanA: 0, meanB: 0, meanC: 0, hue: 0 };
  const meanA = a / n;
  const meanB = b / n;
  const h = meanA === 0 && meanB === 0 ? 0 : (Math.atan2(meanB, meanA) * 180) / Math.PI;
  return { meanL: L / n, meanA, meanB, meanC: C / n, hue: h < 0 ? h + 360 : h };
}

interface Cluster {
  L: number;
  a: number;
  b: number;
  weight: number;
}

/** k-means++ по весам: следующий центр выбирается с вероятностью ∝ w·d². Совпадающие точки не дублируются. */
function seedCenters(labs: Float32Array | Float64Array, weights: Float64Array, total: number, k: number): Vec3[] {
  const n = weights.length;
  const random = mulberry32(SEED);
  const pick = (scores: Float64Array, sum: number): number => {
    let r = random() * sum;
    for (let i = 0; i < n; i++) {
      r -= scores[i] as number;
      if (r < 0) return i;
    }
    // Погрешность суммы: берём последнюю точку с ненулевым весом.
    for (let i = n - 1; i >= 0; i--) if ((scores[i] as number) > 0) return i;
    return 0;
  };
  const at = (i: number): Vec3 => [labs[i * 3] as number, labs[i * 3 + 1] as number, labs[i * 3 + 2] as number];

  const centers = [at(pick(weights, total))];
  const distance = new Float64Array(n).fill(Infinity);
  const scores = new Float64Array(n);
  while (centers.length < k) {
    const last = centers[centers.length - 1] as Vec3;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(distance[i] as number, squaredDistance(labs, i, last));
      distance[i] = d;
      const score = (weights[i] as number) * d;
      scores[i] = score;
      sum += score;
    }
    if (sum <= 0) break;
    centers.push(at(pick(scores, sum)));
  }
  return centers;
}

function nearestCenter(labs: Float32Array | Float64Array, i: number, centers: readonly Vec3[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const d = squaredDistance(labs, i, centers[c] as Vec3);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function squaredDistance(labs: Float32Array | Float64Array, i: number, c: Vec3): number {
  const dL = (labs[i * 3] as number) - c[0];
  const da = (labs[i * 3 + 1] as number) - c[1];
  const db = (labs[i * 3 + 2] as number) - c[2];
  return dL * dL + da * da + db * db;
}

function accumulate(labs: Float32Array | Float64Array, weights: Float64Array, assignment: Int32Array, k: number): Cluster[] {
  const clusters = Array.from({ length: k }, (): Cluster => ({ L: 0, a: 0, b: 0, weight: 0 }));
  for (let i = 0; i < weights.length; i++) {
    const cluster = clusters[assignment[i] as number] as Cluster;
    const w = weights[i] as number;
    cluster.L += w * (labs[i * 3] as number);
    cluster.a += w * (labs[i * 3 + 1] as number);
    cluster.b += w * (labs[i * 3 + 2] as number);
    cluster.weight += w;
  }
  return clusters;
}

function centroid(cluster: Cluster): Vec3 {
  return [cluster.L / cluster.weight, cluster.a / cluster.weight, cluster.b / cluster.weight];
}

/** Сливает ближайшие пары, пока они ближе PALETTE_MERGE_DISTANCE. */
function mergeClose(clusters: Cluster[]): Cluster[] {
  const result = [...clusters];
  for (;;) {
    let pair: [number, number] | null = null;
    let best = PALETTE_MERGE_DISTANCE * PALETTE_MERGE_DISTANCE;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const p = centroid(result[i] as Cluster);
        const q = centroid(result[j] as Cluster);
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < best) {
          best = d;
          pair = [i, j];
        }
      }
    }
    if (!pair) return result;
    const [i, j] = pair;
    const p = result[i] as Cluster;
    const q = result[j] as Cluster;
    result[i] = { L: p.L + q.L, a: p.a + q.a, b: p.b + q.b, weight: p.weight + q.weight };
    result.splice(j, 1);
  }
}

/** Генератор mulberry32: в core нет Math.random, чтобы результат не зависел от запуска. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
