import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { isIdentityCurve, monotoneSpline, sampleCurve } from '@core/color/spline';
import type { Adjust, Pt } from '@core/project/types';
import { CURVE_MAX_POINTS } from '@core/project/validate';

type Channel = keyof Adjust['curves'];

const CHANNELS: { id: Channel; label: string; stroke: string }[] = [
  { id: 'master', label: 'RGB', stroke: 'var(--text)' },
  { id: 'r', label: 'R', stroke: '#f06a6a' },
  { id: 'g', label: 'G', stroke: '#62c46c' },
  { id: 'b', label: 'B', stroke: '#6a9cf0' },
];

/** Сторона графика в единицах viewBox. */
const SIZE = 256;
/** Точек линии: её рисует тот же сплайн Фрича — Карлсона, что и конвейер. */
const SAMPLES = 129;
/** Зазор по x между соседними точками: x должен строго расти (validate.ts). */
const MIN_GAP = 0.01;
/** Радиус попадания в точку и насколько её нужно увести за край графика, чтобы удалить, — в px экрана. */
const HIT_RADIUS = 10;
const REMOVE_MARGIN = 24;

const IDENTITY: readonly Pt[] = [
  [0, 0],
  [1, 1],
];

interface Drag {
  pointerId: number;
  index: number;
  /** Рабочая копия точек: между кадрами React свойства могут отставать от сделанных правок. */
  points: Pt[];
  removed: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
const copy = (points: readonly Pt[]): Pt[] => points.map(([x, y]) => [x, y]);

/**
 * Кривые: общая и по каналам R, G, B. Щелчок добавляет точку и сразу её тянет (у самой линии — точку
 * на линии), перетаскивание двигает,
 * двойной щелчок или увод за край графика удаляет. Крайние точки не удаляются. Один жест — одна запись истории.
 */
export function CurveEditor({
  curves,
  disabled,
  gesture,
  onEdit,
}: {
  curves: Adjust['curves'];
  disabled: boolean;
  gesture: string;
  onEdit: (change: (adjust: Adjust) => void, gesture?: string) => void;
}) {
  const [channel, setChannel] = useState<Channel>('master');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const points = curves[channel];
  const stroke = CHANNELS.find((c) => c.id === channel)?.stroke ?? 'var(--text)';

  const line = useMemo(() => {
    const ys = sampleCurve(points, SAMPLES);
    return Array.from(ys, (y, i) => `${((i / (SAMPLES - 1)) * SIZE).toFixed(2)},${((1 - clamp(y, 0, 1)) * SIZE).toFixed(2)}`).join(' ');
  }, [points]);

  const setPoints = (next: readonly Pt[], gestureKey?: string) =>
    onEdit((a) => void (a.curves[channel] = copy(next)), gestureKey);
  const gestureKey = `${gesture}:curve:${channel}`;

  /** Положение указателя на графике: x вправо, y вверх, 0..1 внутри. */
  const locate = (event: { clientX: number; clientY: number }) => {
    const rect = (svgRef.current as SVGSVGElement).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: 1 - (event.clientY - rect.top) / rect.height, rect };
  };

  const hit = (pts: readonly Pt[], x: number, y: number, rect: DOMRect): number => {
    let best = -1;
    let bestDistance = HIT_RADIUS;
    pts.forEach(([px, py], i) => {
      const d = Math.hypot((px - x) * rect.width, (py - y) * rect.height);
      if (d <= bestDistance) {
        best = i;
        bestDistance = d;
      }
    });
    return best;
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0 || drag.current) return;
    const { x, y, rect } = locate(event);
    const pts = copy(points);
    let index = hit(pts, x, y, rect);
    if (index < 0) {
      // Второй щелчок двойного точку не добавляет; лишних точек не бывает больше CURVE_MAX_POINTS.
      if (event.detail >= 2 || pts.length >= CURVE_MAX_POINTS) return;
      const at = pts.findIndex(([px]) => px > x);
      const prev = pts[at - 1];
      const next = pts[at];
      if (at <= 0 || !prev || !next || next[0] - prev[0] < 2 * MIN_GAP) return;
      const px = clamp(x, prev[0] + MIN_GAP, next[0] - MIN_GAP);
      // Щелчок у самой линии ставит точку на неё: кривая не меняется, пока точку не потянули.
      const onLine = monotoneSpline(points)(px);
      const py = Math.abs(onLine - y) * rect.height <= HIT_RADIUS ? onLine : y;
      pts.splice(at, 0, [round(px), round(clamp(py, 0, 1))]);
      index = at;
      setPoints(pts, gestureKey);
    }
    drag.current = { pointerId: event.pointerId, index, points: pts, removed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || d.removed) return;
    const { x, y, rect } = locate(event);
    const pts = d.points;
    const interior = d.index > 0 && d.index < pts.length - 1;
    const outside = Math.max(-x * rect.width, (x - 1) * rect.width, -y * rect.height, (y - 1) * rect.height);
    if (interior && outside > REMOVE_MARGIN) {
      pts.splice(d.index, 1);
      d.removed = true;
      setPoints(pts, gestureKey);
      return;
    }
    const lo = d.index > 0 ? (pts[d.index - 1] as Pt)[0] + MIN_GAP : 0;
    const hi = d.index < pts.length - 1 ? (pts[d.index + 1] as Pt)[0] - MIN_GAP : 1;
    const moved: Pt = [round(clamp(x, lo, hi)), round(clamp(y, 0, 1))];
    const current = pts[d.index] as Pt;
    if (moved[0] === current[0] && moved[1] === current[1]) return;
    pts[d.index] = moved;
    setPoints(pts, gestureKey);
  };

  const onDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const { x, y, rect } = locate(event);
    const index = hit(points, x, y, rect);
    if (index > 0 && index < points.length - 1) setPoints(points.filter((_, i) => i !== index));
  };

  return (
    <div className="curve-editor">
      <div className="curve-toolbar">
        <div className="segmented" role="tablist" aria-label="Канал кривой">
          {CHANNELS.map(({ id, label }) => (
            <button key={id} role="tab" aria-selected={channel === id} onClick={() => setChannel(id)}>
              {label}
              {!isIdentityCurve(curves[id]) && <span className="curve-changed" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <button className="link" disabled={disabled || isIdentityCurve(points)} onClick={() => setPoints(IDENTITY)}>
          Сбросить
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`curve-graph${disabled ? ' disabled' : ''}`}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        data-testid="curve-editor"
        data-channel={channel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={onDoubleClick}
      >
        <rect className="curve-bg" width={SIZE} height={SIZE} />
        <path
          className="curve-grid"
          d={[1, 2, 3].map((k) => `M${(k * SIZE) / 4} 0V${SIZE}M0 ${(k * SIZE) / 4}H${SIZE}`).join('')}
        />
        <line className="curve-diagonal" x1={0} y1={SIZE} x2={SIZE} y2={0} />
        <polyline className="curve-line" points={line} style={{ stroke }} />
        {points.map(([px, py], i) => (
          <circle key={i} className="curve-point" cx={px * SIZE} cy={(1 - py) * SIZE} r={4.5} />
        ))}
      </svg>
    </div>
  );
}
