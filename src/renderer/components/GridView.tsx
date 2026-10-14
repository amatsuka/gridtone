import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { formatPart } from '@core/harmony/outliers';
import { deviationColor } from '@core/metrics/deviation';
import { labToSrgb8, type TileMetrics } from '@core/metrics/tile';
import { planOrder } from '@core/project/publish';
import type { Project, Slot } from '@core/project/types';
import type { ProjectSnapshot } from '@shared/ipc';
import type { ViewMode } from '@shared/view';
import { gridAnalysis } from '../analysis';
import { openEditor } from '../commands';
import { useMetricsStore } from '../metrics';
import { useAppStore } from '../store';
import { GridCanvas } from './GridCanvas';
import { ProfileHeader } from './ProfileHeader';
import { Tile, type TileOverlay, type TilePlan } from './Tile';
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
  const overlays = useMemo(() => tileOverlays(project, metrics, viewMode), [project, metrics, viewMode]);
  const pinned = project.grid.pinned;
  // Номера публикации — по порядку на экране: при перетаскивании они следуют превью.
  const plan = useMemo(() => tilePlans(slots, pinned), [slots, pinned]);

  const style = {
    '--tile-aspect': project.grid.ratio === '1:1' ? '1 / 1' : '3 / 4',
    '--squint-blur': `${(tileWidth * SQUINT_FRACTION).toFixed(1)}px`,
  } as CSSProperties;
  return (
    <div className={`workspace-frame view-${viewMode}`} style={style} data-testid="workspace" data-view={viewMode}>
      <GridCanvas scrollerRef={scrollerRef} gridRef={gridRef} />
      <div className="workspace" ref={scrollerRef}>
        {project.slots.length === 0 ? (
          <div className="workspace-empty">
            <p>В проекте пока нет фото.</p>
            <p>Нажмите «Импорт фото» или ⌘I.</p>
          </div>
        ) : (
          <div className="grid-column">
            {viewMode === 'profile' && <ProfileHeader project={project} />}
            <div
              className={`grid${dragOrder ? ' dragging' : ''}`}
              data-testid="grid"
              ref={gridRef}
              {...drag}
              // Двойной щелчок по плитке открывает редактор фото, как E.
              onDoubleClick={(e) => {
                const slotId = (e.target as Element).closest<HTMLElement>('[data-slot-id]')?.dataset['slotId'];
                if (slotId) openEditor(slotId);
              }}
            >
              {slots.map((slot, index) => {
                const entry = plan.get(slot.id);
                return (
                  <Tile
                    key={slot.id}
                    slot={slot}
                    index={index}
                    status={slot.assetId ? assets[slot.assetId] : undefined}
                    selected={selected.has(slot.id)}
                    primary={slot.id === selection.primary}
                    renderMode={renderMode}
                    overlay={overlays.get(slot.id)}
                    pinned={index < pinned}
                    order={entry?.order}
                    pin={entry?.pin ?? false}
                    belowPublished={entry?.belowPublished ?? false}
                  />
                );
              })}
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
 * Заливки DOM-слоя: в режиме 5 — доминанта, в режиме 7 — отклонение от ожидания (ADR 0012, 0020): от цели
 * позиции, а без цели — от ожидания сетки (analyzeGrid, от 6 плиток). Ожидания нет — «нет цели», у закреплённой
 * позиции — «закреплён». Пока метрики плитки не готовы, она показывает фото.
 */
function tileOverlays(project: Project, metrics: Readonly<Record<string, TileMetrics>>, mode: ViewMode): Map<string, TileOverlay> {
  const overlays = new Map<string, TileOverlay>();
  if (mode !== 'dominant' && mode !== 'deviation') return overlays;
  const expectations =
    mode === 'deviation' ? new Map(gridAnalysis(project, metrics).expectations.map((e) => [e.slotId, e])) : undefined;
  for (const [index, slot] of project.slots.entries()) {
    if (!slot.assetId) continue;
    const m = metrics[slot.id];
    if (!m) continue;
    if (mode === 'dominant') {
      overlays.set(slot.id, { kind: 'dominant', color: cssRgb(labToSrgb8(m.dominant)) });
      continue;
    }
    const expectation = expectations?.get(slot.id);
    if (!expectation) {
      // Закреплённые — вне анализа (ADR 0022): ожидания у них нет.
      const pinned = index < project.grid.pinned;
      overlays.set(slot.id, {
        kind: 'no-target',
        color: NO_TARGET_COLOR,
        text: pinned ? 'закреплён' : 'нет цели',
        ...(pinned ? { title: 'Закреплённый пост — вне анализа' } : {}),
      });
      continue;
    }
    const d = expectation.deviation;
    const [r, g, b] = deviationColor(d);
    const color = cssRgb([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
    const source = expectation.source === 'target' ? 'Ожидание — цель позиции' : 'Ожидание — по сетке';
    const parts = expectation.parts.map((part) => `${formatPart(part)} (${formatDeviation(part.ratio)})`);
    overlays.set(slot.id, {
      kind: 'deviation',
      color,
      text: formatDeviation(d),
      value: d,
      source: expectation.source,
      title: [source, ...parts].join('\n'),
    });
  }
  return overlays;
}

/** Место каждой позиции в плане публикации (planOrder, ADR 0022), по id слота. */
function tilePlans(slots: readonly Slot[], pinned: number): Map<string, TilePlan> {
  return new Map(planOrder(slots, pinned).map((e) => [e.slotId, { order: e.number, pin: e.pin, belowPublished: e.belowPublished }]));
}

/** Слоты в порядке превью перетаскивания; если превью устарело, — в порядке проекта. */
function previewOrder(slots: readonly Slot[], dragOrder: readonly string[] | null): readonly Slot[] {
  if (!dragOrder || dragOrder.length !== slots.length) return slots;
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const ordered = dragOrder.map((id) => byId.get(id));
  return ordered.every((slot) => slot !== undefined) ? (ordered as Slot[]) : slots;
}
