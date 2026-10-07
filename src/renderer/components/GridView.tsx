import { useMemo, useRef, type CSSProperties } from 'react';
import type { Slot } from '@core/project/types';
import type { ProjectSnapshot } from '@shared/ipc';
import { useAppStore } from '../store';
import { GridCanvas } from './GridCanvas';
import { Tile } from './Tile';
import { useTileDrag } from './useTileDrag';

export function GridView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const { project, assets } = snapshot;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selection = useAppStore((state) => state.selection);
  const dragOrder = useAppStore((state) => state.dragOrder);
  const renderMode = useAppStore((state) => state.renderMode);
  const drag = useTileDrag(gridRef, scrollerRef);

  const slots = useMemo(() => previewOrder(project.slots, dragOrder), [project.slots, dragOrder]);
  const selected = useMemo(() => new Set(selection.ids), [selection.ids]);

  const style = { '--tile-aspect': project.grid.ratio === '1:1' ? '1 / 1' : '3 / 4' } as CSSProperties;
  return (
    <div className="workspace-frame">
      <GridCanvas scrollerRef={scrollerRef} gridRef={gridRef} />
      <div className="workspace" ref={scrollerRef}>
        {project.slots.length === 0 ? (
          <div className="empty">
            <p>В проекте пока нет фото.</p>
            <p>Нажмите «Импорт фото» или ⌘I.</p>
          </div>
        ) : (
          <div
            className={`grid${dragOrder ? ' dragging' : ''}`}
            style={style}
            data-testid="grid"
            ref={gridRef}
            {...drag}
          >
            {slots.map((slot, index) => (
              <Tile
                key={slot.id}
                slot={slot}
                index={index}
                status={slot.assetId ? assets[slot.assetId] : undefined}
                selected={selected.has(slot.id)}
                primary={slot.id === selection.primary}
                renderMode={renderMode}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Слоты в порядке превью перетаскивания; если превью устарело, — в порядке проекта. */
function previewOrder(slots: readonly Slot[], dragOrder: readonly string[] | null): readonly Slot[] {
  if (!dragOrder || dragOrder.length !== slots.length) return slots;
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const ordered = dragOrder.map((id) => byId.get(id));
  return ordered.every((slot) => slot !== undefined) ? (ordered as Slot[]) : slots;
}
