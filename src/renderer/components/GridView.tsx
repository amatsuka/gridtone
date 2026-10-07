import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { deviation, deviationColor } from '@core/metrics/deviation';
import { labToSrgb8, type TileMetrics } from '@core/metrics/tile';
import type { Slot } from '@core/project/types';
import type { ProjectSnapshot } from '@shared/ipc';
import type { ViewMode } from '@shared/view';
import { useMetricsStore } from '../metrics';
import { useAppStore } from '../store';
import { GridCanvas } from './GridCanvas';
import { ProfileHeader } from './ProfileHeader';
import { Tile, type TileOverlay } from './Tile';
import { useTileDrag } from './useTileDrag';

/** Радиус размытия в режиме «Прищур» — доля ширины плитки. */
const SQUINT_FRACTION = 1 / 8;

export function GridView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const { project, assets } = snapshot;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selection = useAppStore((state) => state.selection);
  const dragOrder = useAppStore((state) => state.dragOrder);
  const renderMode = useAppStore((state) => state.renderMode);
  const viewMode = useAppStore((state) => state.viewMode);
  const metrics = useMetricsStore((state) => state.bySlot);
  const drag = useTileDrag(gridRef, scrollerRef);
  const tileWidth = useTileWidth(gridRef, project.slots.length > 0);

  const slots = useMemo(() => previewOrder(project.slots, dragOrder), [project.slots, dragOrder]);
  const selected = useMemo(() => new Set(selection.ids), [selection.ids]);
  const overlays = useMemo(() => tileOverlays(project.slots, metrics, viewMode), [project.slots, metrics, viewMode]);

  const style = {
    '--tile-aspect': project.grid.ratio === '1:1' ? '1 / 1' : '3 / 4',
    '--squint-blur': `${(tileWidth * SQUINT_FRACTION).toFixed(1)}px`,
  } as CSSProperties;
  return (
    <div className={`workspace-frame view-${viewMode}`} style={style} data-testid="workspace" data-view={viewMode}>
      <GridCanvas scrollerRef={scrollerRef} gridRef={gridRef} />
      <div className="workspace" ref={scrollerRef}>
        {project.slots.length === 0 ? (
          <div className="empty">
            <p>В проекте пока нет фото.</p>
            <p>Нажмите «Импорт фото» или ⌘I.</p>
          </div>
        ) : (
          <div className="grid-column">
            {viewMode === 'profile' && <ProfileHeader project={project} />}
            <div className={`grid${dragOrder ? ' dragging' : ''}`} data-testid="grid" ref={gridRef} {...drag}>
              {slots.map((slot, index) => (
                <Tile
                  key={slot.id}
                  slot={slot}
                  index={index}
                  status={slot.assetId ? assets[slot.assetId] : undefined}
                  selected={selected.has(slot.id)}
                  primary={slot.id === selection.primary}
                  renderMode={renderMode}
                  overlay={overlays.get(slot.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ширина плитки на экране: от неё зависит радиус «Прищура». hasGrid — сетка есть в DOM. */
function useTileWidth(gridRef: RefObject<HTMLElement | null>, hasGrid: boolean): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => setWidth((grid.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [gridRef, hasGrid]);
  return width;
}

const NO_TARGET_COLOR = 'rgb(88 88 88)';

const cssRgb = ([r, g, b]: readonly [number, number, number]) => `rgb(${r} ${g} ${b})`;

/** «0.4», «12», «∞»: одна цифра после запятой, пока число небольшое. */
function formatDeviation(d: number): string {
  if (!Number.isFinite(d)) return '∞';
  return d < 10 ? d.toFixed(1) : String(Math.round(d));
}

/**
 * Заливки DOM-слоя: в режиме 5 — доминанта, в режиме 7 — отклонение от цели (ADR 0012).
 * Пока метрики не готовы, плитка показывает фото.
 */
function tileOverlays(slots: readonly Slot[], metrics: Readonly<Record<string, TileMetrics>>, mode: ViewMode): Map<string, TileOverlay> {
  const overlays = new Map<string, TileOverlay>();
  if (mode !== 'dominant' && mode !== 'deviation') return overlays;
  for (const slot of slots) {
    if (!slot.assetId) continue;
    const m = metrics[slot.id];
    if (mode === 'dominant') {
      if (m) overlays.set(slot.id, { kind: 'dominant', color: cssRgb(labToSrgb8(m.dominant)) });
    } else if (!slot.target) {
      overlays.set(slot.id, { kind: 'no-target', color: NO_TARGET_COLOR, text: 'нет цели' });
    } else if (m) {
      const d = deviation(m, slot.target);
      const [r, g, b] = deviationColor(d);
      const color = cssRgb([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
      overlays.set(slot.id, { kind: 'deviation', color, text: formatDeviation(d), value: d });
    }
  }
  return overlays;
}

/** Слоты в порядке превью перетаскивания; если превью устарело, — в порядке проекта. */
function previewOrder(slots: readonly Slot[], dragOrder: readonly string[] | null): readonly Slot[] {
  if (!dragOrder || dragOrder.length !== slots.length) return slots;
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const ordered = dragOrder.map((id) => byId.get(id));
  return ordered.every((slot) => slot !== undefined) ? (ordered as Slot[]) : slots;
}
