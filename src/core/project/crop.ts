// Геометрия кадра: какая часть фото видна в плитке сетки (docs/spec.md, «Два кадра»).
// Кадр ленты — прямоугольник в пропорциях поста внутри фото, повёрнутый на angle; окно сетки — 3:4 или 1:1
// внутри кадра ленты, в его осях. Повёрнутый кадр не выходит за фото — docs/decisions/0013-crop-constraint.md.
// Отсюда же берут геометрию шейдер сетки, метрики и редактор фото.
import type { Crop, Ratio } from './types';
import { CROP_ZOOM_MAX } from './validate';

/** Аффинное отображение (u, v) → (a·u + b·v + c, d·u + e·v + f). */
export type Affine = readonly [number, number, number, number, number, number];
export type Point = [number, number];

const FEED_ASPECT: Record<Crop['feed']['aspect'], number> = { '4:5': 4 / 5, '3:4': 3 / 4, '1:1': 1 };
const GRID_ASPECT: Record<Ratio, number> = { '3:4': 3 / 4, '1:1': 1 };

/** Положения в правках редактора округляются до 10⁻⁶ доли — сотые пикселя: project.json остаётся читаемым. */
const POSITION_STEP = 1e6;
const ZOOM_STEP = 1e3;
/** Запас хода меньше этой доли стороны — хода нет: значение по оси не меняется. */
const ROOM_EPS = 1e-9;

export function applyAffine(m: Affine, u: number, v: number): [number, number] {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

/** Углы прямоугольника 0..1 после отображения: левый верхний, правый верхний, правый нижний, левый нижний. */
export function corners(m: Affine): Point[] {
  return [applyAffine(m, 0, 0), applyAffine(m, 1, 0), applyAffine(m, 1, 1), applyAffine(m, 0, 1)];
}

/** Кадр ленты после ограничений, в пикселях фото. */
interface Feed {
  /** Центр. */
  fcx: number;
  fcy: number;
  /** Ширина и высота. */
  fw: number;
  fh: number;
  /** Полуразмеры описанного прямоугольника повёрнутого кадра: центр не ближе их к краям фото. */
  bx: number;
  by: number;
  /** Поворот по часовой стрелке (ось y вниз). */
  cos: number;
  sin: number;
}

/** Окно сетки: размер и смещение центра от центра кадра, в осях кадра. */
interface Grid {
  gw: number;
  gh: number;
  gx: number;
  gy: number;
}

/**
 * Кадр ленты. При zoom = 1 это наибольший прямоугольник своих пропорций, который в повороте на angle
 * помещается в фото; zoom уменьшает его вокруг центра. Центр (cx, cy) сдвигается так, чтобы описанный
 * прямоугольник повёрнутого кадра не выходил за фото. Без поворота — ровно прежние формулы этапа 1.
 */
function feedOf(width: number, height: number, feed: Crop['feed']): Feed {
  const aspect = FEED_ASPECT[feed.aspect];
  const rad = (feed.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  // Повёрнутый прямоугольник fw × fw/aspect занимает по ширине fw·(c + s/aspect), по высоте fw·(s + c/aspect).
  // При c = 1, s = 0 выражения дают ровно width и height·aspect: без поворота результат бит в бит прежний.
  const fw = Math.min(width / (c + s / aspect), (height * aspect) / (s * aspect + c)) / feed.zoom;
  const fh = fw / aspect;
  const bx = (fw * c + fh * s) / 2;
  const by = (fw * s + fh * c) / 2;
  return { fcx: clamp(feed.cx * width, bx, width - bx), fcy: clamp(feed.cy * height, by, height - by), fw, fh, bx, by, cos, sin };
}

/** Окно сетки вписано в кадр ленты и двигается внутри него. */
function gridOf(f: Feed, grid: Crop['grid'], ratio: Ratio): Grid {
  const gridAspect = GRID_ASPECT[ratio];
  const gw = Math.min(f.fw, f.fh * gridAspect);
  const gh = gw / gridAspect;
  const gx = clamp(grid.cx * f.fw, gw / 2, f.fw - gw / 2) - f.fw / 2;
  const gy = clamp(grid.cy * f.fh, gh / 2, f.fh - gh / 2) - f.fh / 2;
  return { gw, gh, gx, gy };
}

/** Прямоугольник w × h со смещением (ox, oy) от центра кадра в его осях: точка 0..1 → нормированные координаты фото. */
function rectTransform(width: number, height: number, f: Feed, w: number, h: number, ox: number, oy: number): Affine {
  // Точка → смещение от центра кадра → поворот → пиксели фото → 0..1.
  const map = (u: number, v: number): [number, number] => {
    const x = (u - 0.5) * w + ox;
    const y = (v - 0.5) * h + oy;
    return [(f.fcx + x * f.cos - y * f.sin) / width, (f.fcy + x * f.sin + y * f.cos) / height];
  };
  const [c, d] = map(0, 0);
  const [ua, va] = map(1, 0);
  const [ub, vb] = map(0, 1);
  return [ua - c, ub - c, c, va - d, vb - d, d];
}

/** Координаты плитки (0..1, начало в левом верхнем углу) → нормированные координаты фото. */
export function gridWindowTransform(width: number, height: number, crop: Crop, ratio: Ratio): Affine {
  const f = feedOf(width, height, crop.feed);
  const g = gridOf(f, crop.grid, ratio);
  return rectTransform(width, height, f, g.gw, g.gh, g.gx, g.gy);
}

/** Координаты кадра ленты (0..1, начало в его левом верхнем углу) → нормированные координаты фото. */
export function feedFrameTransform(width: number, height: number, crop: Crop): Affine {
  const f = feedOf(width, height, crop.feed);
  return rectTransform(width, height, f, f.fw, f.fh, 0, 0);
}

/** Кадр ленты и окно сетки после ограничений, в пикселях фото (ось y вниз). */
export interface CropGeometry {
  feedCenter: Point;
  /** Ширина и высота кадра ленты. */
  feedSize: Point;
  /** Запас хода центра кадра от центра фото по осям фото; 0 — кадр упирается в оба края. */
  feedRoom: Point;
  /** Смещение центра окна сетки от центра кадра, в осях кадра. */
  gridOffset: Point;
  gridSize: Point;
  /** Запас хода окна от центра кадра по осям кадра. */
  gridRoom: Point;
}

export function cropGeometry(width: number, height: number, crop: Crop, ratio: Ratio): CropGeometry {
  const f = feedOf(width, height, crop.feed);
  const g = gridOf(f, crop.grid, ratio);
  return {
    feedCenter: [f.fcx, f.fcy],
    feedSize: [f.fw, f.fh],
    feedRoom: [width / 2 - f.bx, height / 2 - f.by],
    gridOffset: [g.gx, g.gy],
    gridSize: [g.gw, g.gh],
    gridRoom: [(f.fw - g.gw) / 2, (f.fh - g.gh) / 2],
  };
}

// ─── Правки редактора ───────────────────────────────────────────────────────
// Сдвиг указателя (du, dv) — в долях фото от начала жеста; кадр в начале жеста — как сохранён.
// Отсчёт идёт от видимого положения, а не от сохранённого: значение за пределами допустимого
// не создаёт мёртвой зоны. Ось без запаса хода сохраняет своё значение, так что поворот и масштаб,
// снятые обратно, возвращают кадр на прежнее место.

/** Перемещение кадра ленты: центр следует за указателем и упирается в края фото. Окно сетки едет вместе с кадром. */
export function dragFeed(width: number, height: number, crop: Crop, [du, dv]: Point): Crop {
  const f = feedOf(width, height, crop.feed);
  return {
    feed: {
      ...crop.feed,
      cx: moveAxis(crop.feed.cx, f.fcx + du * width, f.bx, width),
      cy: moveAxis(crop.feed.cy, f.fcy + dv * height, f.by, height),
    },
    grid: { ...crop.grid },
  };
}

/**
 * Перемещение окна сетки. Сдвиг переводится в оси кадра; окно ходит внутри кадра, а то, что не
 * поместилось в его запас, толкает кадр ленты. Окно 3:4 в кадре 4:5, 3:4 или 1:1 занимает всю его
 * высоту, поэтому сдвиг окна по вертикали двигает кадр.
 */
export function dragGridWindow(width: number, height: number, crop: Crop, ratio: Ratio, [du, dv]: Point): Crop {
  const f = feedOf(width, height, crop.feed);
  const g = gridOf(f, crop.grid, ratio);
  const dx = du * width;
  const dy = dv * height;
  // Поворот на −angle: из осей фото в оси кадра. Положение окна — от левого верхнего угла кадра.
  const wantX = g.gx + f.fw / 2 + (dx * f.cos + dy * f.sin);
  const wantY = g.gy + f.fh / 2 + (-dx * f.sin + dy * f.cos);
  const overX = wantX - clamp(wantX, g.gw / 2, f.fw - g.gw / 2);
  const overY = wantY - clamp(wantY, g.gh / 2, f.fh - g.gh / 2);
  const grid = {
    cx: moveAxis(crop.grid.cx, wantX, g.gw / 2, f.fw),
    cy: moveAxis(crop.grid.cy, wantY, g.gh / 2, f.fh),
  };
  if (overX === 0 && overY === 0) return { feed: { ...crop.feed }, grid };
  // Остаток — обратно в оси фото: на столько же сдвигается кадр.
  const push: Point = [(overX * f.cos - overY * f.sin) / width, (overX * f.sin + overY * f.cos) / height];
  return { feed: dragFeed(width, height, crop, push).feed, grid };
}

/**
 * Масштаб за угол кадра: zoom меняется обратно расстоянию указателя до центра кадра. Угол, уведённый
 * вдвое дальше от центра, — кадр вдвое больше. Пределы — 1…CROP_ZOOM_MAX.
 */
export function zoomByHandle(width: number, height: number, crop: Crop, from: Point, to: Point): Crop {
  const f = feedOf(width, height, crop.feed);
  const d0 = Math.hypot(from[0] * width - f.fcx, from[1] * height - f.fcy);
  const d1 = Math.hypot(to[0] * width - f.fcx, to[1] * height - f.fcy);
  if (!(d0 > 0)) return { feed: { ...crop.feed }, grid: { ...crop.grid } };
  const zoom = d1 > 0 ? Math.round(((crop.feed.zoom * d0) / d1) * ZOOM_STEP) / ZOOM_STEP : CROP_ZOOM_MAX;
  return { feed: { ...crop.feed, zoom: clamp(zoom, 1, CROP_ZOOM_MAX) }, grid: { ...crop.grid } };
}

/**
 * Новое положение центра на оси длиной length: want в пикселях, центр не ближе half к краям.
 * Результат — доля length. Без запаса хода — прежнее значение stored.
 */
function moveAxis(stored: number, want: number, half: number, length: number): number {
  if (length - 2 * half <= ROOM_EPS * length) return stored;
  return clamp(Math.round((clamp(want, half, length - half) / length) * POSITION_STEP) / POSITION_STEP, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
