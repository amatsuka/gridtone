// Редактор фото (docs/spec.md, «Экраны»): слой поверх окна, крупный кадр на прокси 2048 с кадром ленты
// и окном сетки, коррекция и кадр. Открывается по E и двойному щелчку, закрывается по Esc; ←/→ — соседний
// пост, `\` — до/после. Правки идут через editProject: история общая с сеткой (ADR 0011).
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  applyAffine,
  corners,
  dragFeed,
  dragGridWindow,
  feedFrameTransform,
  gridWindowTransform,
  zoomByHandle,
  type Affine,
  type Point,
} from '@core/project/crop';
import { createAdjust, createCrop } from '@core/project/defaults';
import { sameJson } from '@core/project/json';
import type { AssetRef, Crop, Project, Ratio, Slot } from '@core/project/types';
import { CROP_ANGLE_MAX, CROP_ZOOM_MAX } from '@core/project/validate';
import { proxyUrl } from '@shared/cache';
import type { ProjectSnapshot } from '@shared/ipc';
import { closeEditor, editSlotAdjust, editSlotCrop, setEditorTab, stepEditor } from '../commands';
import { PhotoRenderer } from '../gl/PhotoRenderer';
import { useAppStore, type EditorTab } from '../store';
import { AdjustPanel } from './AdjustPanel';
import { viewOutput } from './GridCanvas';
import { Slider } from './Slider';

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'color', label: 'Цвет' },
  { id: 'crop', label: 'Кадр' },
];

const ASPECTS: Crop['feed']['aspect'][] = ['4:5', '3:4', '1:1'];

/** Поле вокруг фото на сцене, CSS px: углы кадра и их ручки не прилипают к краю. */
const STAGE_PADDING = 28;
/** Ручка угла кадра, CSS px. */
const HANDLE_RADIUS = 6;

type Rect = [number, number, number, number];

export function PhotoEditor() {
  const slotId = useAppStore((state) => state.editorSlotId);
  const snapshot = useAppStore((state) => state.snapshot);
  const slot = snapshot?.project.slots.find((s) => s.id === slotId);
  const asset = slot?.assetId ? snapshot?.project.assets[slot.assetId] : undefined;
  if (!snapshot || !slot || !asset) return null;
  // Один экземпляр на всё время, пока редактор открыт: при ←/→ контекст WebGL и текстуры остаются.
  return <EditorView snapshot={snapshot} slot={slot} asset={asset} />;
}

function EditorView({ snapshot, slot, asset }: { snapshot: ProjectSnapshot; slot: Slot; asset: AssetRef }) {
  const tab = useAppStore((state) => state.editorTab);
  const showOriginal = useAppStore((state) => state.showOriginal);
  // Под диалогом экспорта редактор не получает ни фокуса, ни кликов.
  const exportOpen = useAppStore((state) => state.exportOpen);
  const [rotating, setRotating] = useState(false);
  const { project } = snapshot;
  const index = project.slots.indexOf(slot);
  const photos = project.slots.filter((s) => s.assetId !== undefined);
  const photoIndex = photos.indexOf(slot);
  // Опубликованные посты только участвуют в анализе (spec, «Статусы позиций»).
  const locked = slot.state === 'published';

  return (
    <div
      className="photo-editor"
      role="dialog"
      aria-label="Редактор фото"
      data-testid="photo-editor"
      data-slot-id={slot.id}
      inert={exportOpen}
    >
      <header className="editor-header">
        <button aria-label="Предыдущий пост" title="Предыдущий пост — ←" disabled={photoIndex <= 0} onClick={() => stepEditor(-1)}>
          ←
        </button>
        <span className="editor-position" data-testid="editor-position">
          Пост {index + 1} из {project.slots.length}
        </span>
        <button
          aria-label="Следующий пост"
          title="Следующий пост — →"
          disabled={photoIndex >= photos.length - 1}
          onClick={() => stepEditor(1)}
        >
          →
        </button>
        <div className="tabs editor-tabs" role="tablist">
          {TABS.map(({ id, label }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setEditorTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {showOriginal && (
          <span className="original-badge" data-testid="editor-original-badge">
            До правок
          </span>
        )}
        <button className="primary" title="Esc" onClick={closeEditor}>
          Готово
        </button>
      </header>
      <div className="editor-body">
        <EditorStage project={project} slot={slot} asset={asset} tab={tab} locked={locked} rotating={rotating} />
        <aside className="inspector editor-panel" data-testid="editor-panel">
          {tab === 'color' ? (
            <ColorPanel project={project} slot={slot} locked={locked} />
          ) : (
            <CropPanel slot={slot} locked={locked} onRotating={setRotating} />
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Сцена: фото на холсте и контуры кадра поверх ──────────────────────────

function EditorStage({
  project,
  slot,
  asset,
  tab,
  locked,
  rotating,
}: {
  project: Project;
  slot: Slot;
  asset: AssetRef;
  tab: EditorTab;
  locked: boolean;
  rotating: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PhotoRenderer | null>(null);
  const [glFailed, setGlFailed] = useState(false);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const viewMode = useAppStore((state) => state.viewMode);
  const showOriginal = useAppStore((state) => state.showOriginal);
  const proxyReady = useAppStore((state) => (slot.assetId ? state.snapshot?.assets[slot.assetId]?.proxy === 'ready' : false));

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setSize([stage.clientWidth, stage.clientHeight]);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new PhotoRenderer(canvas);
    } catch (err) {
      console.error(err);
      setGlFailed(true);
      return;
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  const rect = fitRect(size, asset.w, asset.h);
  const look = slot.lookId ? project.looks.find((l) => l.id === slot.lookId)?.adjust : undefined;
  const neighbors = neighborAssets(project, slot);

  // Сцена обновляется после каждого рендера: кадры схлопываются в один requestAnimationFrame.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !slot.assetId) return;
    renderer.setScene(
      proxyReady
        ? {
            assetId: slot.assetId,
            preload: neighbors,
            adjusts: showOriginal ? [] : look ? [slot.adjust, look] : [slot.adjust],
            view: viewOutput(viewMode),
            rect,
          }
        : null,
    );
  });

  return (
    <div className="editor-stage" ref={stageRef} data-testid="editor-stage">
      <canvas ref={canvasRef} className="editor-canvas" data-testid="editor-canvas" aria-hidden="true" />
      {glFailed && proxyReady && slot.assetId && (
        // Без WebGL2 — картинка без коррекции, как и в сетке.
        <img
          className="editor-fallback"
          src={proxyUrl(slot.assetId, 2048)}
          alt=""
          style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }}
        />
      )}
      {!proxyReady && <div className="editor-placeholder">Готовим превью…</div>}
      {rect[2] > 0 && (
        <CropOverlay slot={slot} asset={asset} ratio={project.grid.ratio} rect={rect} tab={tab} locked={locked} rotating={rotating} />
      )}
    </div>
  );
}

/** Фото целиком внутри сцены, по центру; целые CSS-пиксели, чтобы контуры кадра совпадали с краями фото. */
function fitRect([width, height]: [number, number], photoW: number, photoH: number): Rect {
  const scale = Math.min((width - 2 * STAGE_PADDING) / photoW, (height - 2 * STAGE_PADDING) / photoH);
  if (!(scale > 0)) return [0, 0, 0, 0];
  const w = Math.round(photoW * scale);
  const h = Math.round(photoH * scale);
  return [Math.round((width - w) / 2), Math.round((height - h) / 2), w, h];
}

/** Ассеты соседних постов с фото: их прокси 2048 редактор грузит заранее. */
function neighborAssets(project: Project, slot: Slot): string[] {
  const photos = project.slots.filter((s) => s.assetId !== undefined);
  const i = photos.indexOf(slot);
  return [photos[i - 1], photos[i + 1]].flatMap((s) => (s?.assetId ? [s.assetId] : []));
}

interface CropDrag {
  pointerId: number;
  role: 'feed' | 'grid' | 'handle';
  /** Кадр и точка указателя в начале жеста: правка считается от них, а не накапливается. */
  start: Crop;
  from: Point;
}

/**
 * Контуры кадра ленты и окна сетки поверх фото. Во вкладке «Кадр» их можно тянуть: внутри окна сетки —
 * окно (у края оно толкает кадр), в остальной части кадра — кадр, за ручки углов — масштаб.
 * Геометрия — core/project/crop.ts, в координатах оригинала (ADR 0013).
 */
function CropOverlay({
  slot,
  asset,
  ratio,
  rect,
  tab,
  locked,
  rotating,
}: {
  slot: Slot;
  asset: AssetRef;
  ratio: Ratio;
  rect: Rect;
  tab: EditorTab;
  locked: boolean;
  rotating: boolean;
}) {
  const drag = useRef<CropDrag | null>(null);
  const { w: W, h: H } = asset;
  const feed = feedFrameTransform(W, H, slot.crop);
  const feedPoints = toPixels(corners(feed), W, H);
  const gridPoints = toPixels(corners(gridWindowTransform(W, H, slot.crop, ratio)), W, H);
  const editable = tab === 'crop' && !locked;
  /** Пикселей фото в одном CSS-пикселе: ручки и линии одного размера на экране. */
  const unit = W / rect[2];

  const locate = (event: { clientX: number; clientY: number; currentTarget: Element }): Point => {
    const r = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height];
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!editable || event.button !== 0 || drag.current) return;
    const role = (event.target as Element).getAttribute('data-role');
    if (role !== 'feed' && role !== 'grid' && role !== 'handle') return;
    drag.current = { pointerId: event.pointerId, role, start: slot.crop, from: locate(event) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const to = locate(event);
    const delta: Point = [to[0] - d.from[0], to[1] - d.from[1]];
    const next =
      d.role === 'feed'
        ? dragFeed(W, H, d.start, delta)
        : d.role === 'grid'
          ? dragGridWindow(W, H, d.start, ratio, delta)
          : zoomByHandle(W, H, d.start, d.from, to);
    // Одно движение мыши от нажатия до отпускания — одна запись истории.
    editSlotCrop(slot.id, (crop) => assignCrop(crop, next), `crop:${slot.id}:${d.role}`);
  };

  const onPointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <svg
      className={`crop-overlay crop-overlay-${tab}${editable ? ' editable' : ''}`}
      style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      data-testid="crop-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {tab === 'crop' && <path className="crop-shade" fillRule="evenodd" d={`M0 0H${W}V${H}H0Z${polygonPath(feedPoints)}`} />}
      <polygon className="crop-feed" data-role="feed" data-testid="crop-feed" points={pointList(feedPoints)} />
      {tab === 'crop' && <path className="crop-guides" d={guides(feed, W, H, rotating ? 8 : 3)} />}
      <polygon className="crop-grid" data-role="grid" data-testid="crop-grid" points={pointList(gridPoints)} />
      {editable &&
        feedPoints.map(([x, y], i) => (
          <circle key={i} className="crop-handle" data-role="handle" data-testid="crop-handle" cx={x} cy={y} r={HANDLE_RADIUS * unit} />
        ))}
    </svg>
  );
}

/** Правка кадра в черновике Immer: совпадающие значения патчей не дают. */
function assignCrop(crop: Crop, next: Crop): void {
  Object.assign(crop.feed, next.feed);
  Object.assign(crop.grid, next.grid);
}

function toPixels(points: Point[], W: number, H: number): Point[] {
  return points.map(([u, v]) => [u * W, v * H]);
}

function pointList(points: Point[]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function polygonPath(points: Point[]): string {
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`;
}

/** Линии сетки внутри кадра ленты: n × n ячеек, в осях кадра — по ним выравнивают горизонт. */
function guides(feed: Affine, W: number, H: number, n: number): string {
  const segments: string[] = [];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    for (const [a, b] of [
      [applyAffine(feed, t, 0), applyAffine(feed, t, 1)],
      [applyAffine(feed, 0, t), applyAffine(feed, 1, t)],
    ] as const) {
      segments.push(`M${(a[0] * W).toFixed(2)} ${(a[1] * H).toFixed(2)}L${(b[0] * W).toFixed(2)} ${(b[1] * H).toFixed(2)}`);
    }
  }
  return segments.join('');
}

// ─── Панели справа ──────────────────────────────────────────────────────────

function ColorPanel({ project, slot, locked }: { project: Project; slot: Slot; locked: boolean }) {
  const look = slot.lookId ? project.looks.find((l) => l.id === slot.lookId) : undefined;
  return (
    <>
      <header className="inspector-header">
        <h2>Поправка фото</h2>
        <button className="link" disabled={locked} onClick={() => editSlotAdjust(slot.id, (a) => Object.assign(a, createAdjust()))}>
          Сбросить
        </button>
      </header>
      {locked && <p className="muted">Опубликованный пост не редактируется.</p>}
      {look && <p className="muted">Поверх накладывается образ «{look.name}». Его правят во вкладке «Образ» инспектора.</p>}
      <AdjustPanel
        adjust={slot.adjust}
        disabled={locked}
        gesture={`slot:${slot.id}`}
        onEdit={(change, gesture) => editSlotAdjust(slot.id, change, gesture)}
      />
    </>
  );
}

function CropPanel({ slot, locked, onRotating }: { slot: Slot; locked: boolean; onRotating: (rotating: boolean) => void }) {
  const { feed, grid } = slot.crop;
  const edit = (change: (crop: Crop) => void, gesture?: string) => editSlotCrop(slot.id, change, gesture);
  const centered = grid.cx === 0.5 && grid.cy === 0.5;

  return (
    <>
      <header className="inspector-header">
        <h2>Кадр</h2>
        <button className="link" disabled={locked || sameJson(slot.crop, createCrop())} onClick={() => edit((c) => assignCrop(c, createCrop()))}>
          Сбросить
        </button>
      </header>
      {locked && <p className="muted">Опубликованный пост не редактируется.</p>}
      <section className="inspector-group">
        <h3>Пропорции ленты</h3>
        <div className="segmented" role="group" aria-label="Пропорции ленты" data-testid="feed-aspect">
          {ASPECTS.map((aspect) => (
            <button
              key={aspect}
              aria-pressed={feed.aspect === aspect}
              disabled={locked}
              onClick={() => edit((c) => void (c.feed.aspect = aspect))}
            >
              {aspect}
            </button>
          ))}
        </div>
      </section>
      <section className="inspector-group">
        <h3>Кадр ленты</h3>
        <Slider
          label="Масштаб"
          value={feed.zoom}
          min={1}
          max={CROP_ZOOM_MAX}
          step={0.01}
          disabled={locked}
          testId="value-zoom"
          format={(v) => `×${v.toFixed(2)}`}
          onChange={(value) => edit((c) => void (c.feed.zoom = value), `crop:${slot.id}:zoom`)}
          onReset={() => edit((c) => void (c.feed.zoom = 1))}
        />
        <AngleControl
          value={feed.angle}
          disabled={locked}
          onChange={(value, gesture) => edit((c) => void (c.feed.angle = value), gesture ? `crop:${slot.id}:angle` : undefined)}
          onRotating={onRotating}
        />
      </section>
      <section className="inspector-group">
        <h3>Окно сетки</h3>
        <p className="muted">
          Окно — то, что видно в плитке сетки. Тяните его на фото; упираясь в край кадра ленты, оно двигает кадр.
        </p>
        <button disabled={locked || centered} onClick={() => edit((c) => Object.assign(c.grid, { cx: 0.5, cy: 0.5 }))}>
          По центру кадра
        </button>
      </section>
      <p className="muted editor-hint">Кадр ленты тянется за свободную часть, масштаб — за углы.</p>
    </>
  );
}

/** «+15.0°», «−2.5°», «0°». */
function formatAngle(value: number): string {
  if (value === 0) return '0°';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}°`;
}

/** Поворот: ползунок с шагом 0.1° и поле для точного угла. Двойной щелчок по ползунку сбрасывает. */
function AngleControl({
  value,
  disabled,
  onChange,
  onRotating,
}: {
  value: number;
  disabled: boolean;
  /** gesture — правка ползунком: движение склеивается в одну запись истории. */
  onChange: (value: number, gesture?: boolean) => void;
  onRotating: (rotating: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const cancelled = useRef(false);
  // Отмена, повтор и ползунок меняют угол снаружи.
  useEffect(() => setDraft(String(value)), [value]);

  // Сетка поворота гаснет при отпускании мыши где угодно.
  useEffect(() => {
    const stop = () => onRotating(false);
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, [onRotating]);

  const commit = () => {
    const parsed = Number(draft.replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(CROP_ANGLE_MAX, Math.max(-CROP_ANGLE_MAX, Math.round(parsed * 100) / 100));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="slider angle-control">
      <span className="slider-label">Поворот</span>
      <output className="slider-value" data-testid="value-angle">
        {formatAngle(value)}
      </output>
      <input
        type="range"
        aria-label="Поворот"
        min={-CROP_ANGLE_MAX}
        max={CROP_ANGLE_MAX}
        step={0.1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.currentTarget.value), true)}
        onDoubleClick={() => !disabled && onChange(0)}
        onPointerDown={() => onRotating(true)}
        onKeyDown={() => onRotating(true)}
        onKeyUp={() => onRotating(false)}
        onBlur={() => onRotating(false)}
      />
      <label className="angle-field">
        <span>Угол, °</span>
        <input
          type="number"
          aria-label="Угол поворота"
          min={-CROP_ANGLE_MAX}
          max={CROP_ANGLE_MAX}
          step={0.1}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              setDraft(String(value));
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            if (!cancelled.current) commit();
            cancelled.current = false;
          }}
        />
      </label>
    </div>
  );
}
