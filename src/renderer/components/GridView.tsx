import type { CSSProperties } from 'react';
import type { ProjectSnapshot } from '@shared/ipc';
import { Tile } from './Tile';

export function GridView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const { project, assets } = snapshot;

  if (project.slots.length === 0) {
    return (
      <div className="empty">
        <p>В проекте пока нет фото.</p>
        <p>Нажмите «Импорт фото» или ⌘I.</p>
      </div>
    );
  }

  const style = { '--tile-aspect': project.grid.ratio === '1:1' ? '1 / 1' : '3 / 4' } as CSSProperties;
  return (
    <div className="grid" style={style} data-testid="grid">
      {project.slots.map((slot, index) => (
        <Tile key={slot.id} slot={slot} index={index} status={slot.assetId ? assets[slot.assetId] : undefined} />
      ))}
    </div>
  );
}
