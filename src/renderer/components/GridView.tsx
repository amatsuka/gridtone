import { useRef, type CSSProperties } from 'react';
import type { ProjectSnapshot } from '@shared/ipc';
import { useAppStore } from '../store';
import { GridCanvas } from './GridCanvas';
import { Tile } from './Tile';

export function GridView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const { project, assets } = snapshot;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const selectedSlotId = useAppStore((state) => state.selectedSlotId);
  const renderMode = useAppStore((state) => state.renderMode);

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
          <div className="grid" style={style} data-testid="grid" ref={gridRef}>
            {project.slots.map((slot, index) => (
              <Tile
                key={slot.id}
                slot={slot}
                index={index}
                status={slot.assetId ? assets[slot.assetId] : undefined}
                selected={slot.id === selectedSlotId}
                renderMode={renderMode}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
