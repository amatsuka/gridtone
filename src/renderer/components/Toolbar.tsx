import type { ProjectSnapshot, SaveState } from '@shared/ipc';
import { api } from '../store';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Сохранено',
  pending: 'Сохраняется…',
  saving: 'Сохраняется…',
  error: 'Ошибка сохранения',
};

export function Toolbar({ snapshot }: { snapshot: ProjectSnapshot | null }) {
  return (
    <header className="toolbar">
      <span className="brand">Gridtone</span>
      {snapshot && (
        <>
          <span className="project-name" data-testid="project-name" title={snapshot.dir}>
            {snapshot.project.name}
          </span>
          <span
            className={`save-state save-state-${snapshot.save.state}`}
            data-testid="save-state"
            title={snapshot.save.error}
          >
            {SAVE_LABEL[snapshot.save.state]}
          </span>
          <div className="spacer" />
          <button onClick={() => void api.invoke('project:create')}>Новый проект</button>
          <button onClick={() => void api.invoke('project:open')}>Открыть проект</button>
          <button onClick={() => void api.invoke('project:close')}>Закрыть</button>
          <button className="primary" onClick={() => void api.invoke('assets:import')}>
            Импорт фото
          </button>
        </>
      )}
    </header>
  );
}
