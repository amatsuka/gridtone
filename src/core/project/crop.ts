// Геометрия кадра: какая часть фото видна в плитке сетки (docs/spec.md, «Два кадра»).
// Кадр ленты — прямоугольник в пропорциях поста внутри фото; окно сетки — 3:4 или 1:1 внутри кадра ленты.
import type { Crop, Ratio } from './types';

/** Аффинное отображение (u, v) → (a·u + b·v + c, d·u + e·v + f). */
export type Affine = readonly [number, number, number, number, number, number];

const FEED_ASPECT: Record<Crop['feed']['aspect'], number> = { '4:5': 4 / 5, '3:4': 3 / 4, '1:1': 1 };
const GRID_ASPECT: Record<Ratio, number> = { '3:4': 3 / 4, '1:1': 1 };

export function applyAffine(m: Affine, u: number, v: number): [number, number] {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

/**
 * Координаты плитки (0..1, начало в левом верхнем углу) → нормированные координаты фото.
 * Кадр ленты при zoom = 1 — наибольший прямоугольник своих пропорций внутри фото; центр
 * (cx, cy) сдвигается так, чтобы кадр не выходил за фото. Окно сетки так же вписано в кадр ленты.
 * Поворот (angle, градусы, по часовой) вращает окно вокруг центра кадра; выход повёрнутого
 * кадра за фото пока не ограничивается — это придёт с редактором кадра.
 */
export function gridWindowTransform(width: number, height: number, crop: Crop, ratio: Ratio): Affine {
  const { feed, grid } = crop;
  const feedAspect = FEED_ASPECT[feed.aspect];
  const fw = Math.min(width, height * feedAspect) / feed.zoom;
  const fh = fw / feedAspect;
  const fcx = clamp(feed.cx * width, fw / 2, width - fw / 2);
  const fcy = clamp(feed.cy * height, fh / 2, height - fh / 2);

  const gridAspect = GRID_ASPECT[ratio];
  const gw = Math.min(fw, fh * gridAspect);
  const gh = gw / gridAspect;
  const gx = clamp(grid.cx * fw, gw / 2, fw - gw / 2) - fw / 2;
  const gy = clamp(grid.cy * fh, gh / 2, fh - gh / 2) - fh / 2;

  // Точка плитки → смещение от центра кадра → поворот → пиксели фото → 0..1.
  const rad = (feed.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (u: number, v: number): [number, number] => {
    const x = (u - 0.5) * gw + gx;
    const y = (v - 0.5) * gh + gy;
    return [(fcx + x * cos - y * sin) / width, (fcy + x * sin + y * cos) / height];
  };
  const [c, f] = map(0, 0);
  const [ua, va] = map(1, 0);
  const [ub, vb] = map(0, 1);
  return [ua - c, ub - c, c, va - f, vb - f, f];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
