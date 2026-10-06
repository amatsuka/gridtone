// Модель данных проекта — docs/spec.md, «Модель данных».
// Отступление от спеки: Project.assets (docs/decisions/0003-assets-in-project.md).

export type Ratio = '3:4' | '1:1';
export type Vec3 = [number, number, number]; // OKLab: L 0..1, a, b
export type Pt = [number, number]; // точка кривой, 0..1

export interface Project {
  version: 1;
  name: string;
  grid: { ratio: Ratio; columns: 3; pinned: 0 | 1 | 2 | 3 }; // pinned — закреплённые посты сверху
  assets: Record<string, AssetRef>; // ключ — AssetRef.id
  slots: Slot[]; // порядок = порядок в сетке, 0 — верхний левый
  looks: Look[]; // общие образы, каждый экспортируется в LUT
  pattern?: Pattern; // активная цель
  reference?: ReferenceGrid; // разобранная чужая сетка
}

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'tiff';

/** Оригинал фото. Сам файл никогда не меняется; прокси лежат в cache/ проекта. */
export interface AssetRef {
  id: string; // первые 16 hex-символов hash
  path: string; // абсолютный путь к оригиналу
  hash: string; // SHA-256 содержимого, hex
  w: number; // размеры с учётом EXIF-ориентации
  h: number;
  format: ImageFormat;
  icc: 'embedded' | 'assumed-srgb'; // откуда взят профиль при переводе в sRGB
  importedAt: string; // ISO 8601
}

export interface Slot {
  id: string;
  state: 'published' | 'planned' | 'empty'; // published — скриншот вышедшего поста, только для анализа
  assetId?: string;
  postType: 'photo' | 'carousel' | 'reels';
  crop: Crop;
  adjust: Adjust; // поправка этого фото: приводит его к образу
  lookId?: string;
  target?: SlotTarget; // цель из паттерна или референса
  candidates: Candidate[]; // варианты для перебора в позиции
  choiceLocked: boolean; // выбор зафиксирован, автоподбор его не трогает
}

export interface Crop {
  feed: { aspect: '4:5' | '3:4' | '1:1'; cx: number; cy: number; zoom: number; angle: number };
  grid: { cx: number; cy: number }; // окно 3:4 внутри кадра ленты, по умолчанию центр
}

export interface Adjust {
  exposure: number; // EV, −3..+3
  temp: number; // −100..+100
  tint: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  hsl: Record<HueBand, { hue: number; sat: number; lum: number }>;
  grading: { shadows: Wheel; midtones: Wheel; highlights: Wheel; balance: number };
  curves: { master: Pt[]; r: Pt[]; g: Pt[]; b: Pt[] };
}

export type HueBand = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';

export interface Wheel {
  hue: number;
  amount: number;
}

export interface Look {
  id: string;
  name: string;
  adjust: Adjust;
  importedLut?: string;
}

export interface SlotTarget {
  L: number; // OKLab L
  hue?: number; // задаются, если цвет важен
  chroma?: number;
  palette?: Vec3[];
  tolerance: { L: number; hue: number; chroma: number };
  hard: boolean; // true — плоская заливка шаблона, false — снято с фото
}

export interface Pattern {
  source: 'generator' | 'string' | 'image' | 'reference';
  periodRows: number; // паттерн повторяется вниз с этим периодом
  postingMode: 'single' | 'batch'; // переживает одиночные посты или только пачки по 3
  cells: SlotTarget[];
}

export interface ReferenceGrid {
  imagePath: string;
  cells: Features[];
  look?: Look;
}

export interface Features {
  meanL: number;
  p05L: number;
  p50L: number;
  p95L: number;
  lHist: number[]; // 8 корзин
  meanA: number;
  meanB: number;
  meanC: number;
  hueHist: number[]; // 12 корзин по 30°, вес = хрома
  palette: { lab: Vec3; share: number }[]; // k-means, k = 5
  neutralShare: number; // доля пикселей с хромой < 0.03
  busyness: number; // энергия краёв по Собелю
}

export interface Candidate {
  assetId: string;
  score: number;
  parts: { L: number; hue: number; chroma: number; palette: number; penalty: number };
}
