import type { ProjectSnapshot, SaveState } from '@shared/ipc';
import { PINNED_MAX } from '@core/project/validate';
import { VIEW_MODE_LABELS, VIEW_MODES } from '@shared/view';
import { insertEmptyPositions, openExportDialog, setPinned, setViewMode } from '../commands';
import { api, useAppStore } from '../store';

const COLUMNS = 3;
const PINNED_OPTIONS = Array.from({ length: PINNED_MAX + 1 }, (_, n) => n);

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Сохранено',
  pending: 'Сохраняется…',
  saving: 'Сохраняется…',
  error: 'Ошибка сохранения',
};

export function Toolbar({ snapshot }: { snapshot: ProjectSnapshot | null }) {
  const viewMode = useAppStore((state) => state.viewMode);
  const showOriginal = useAppStore((state) => state.showOriginal);
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
          {showOriginal && (
            <span className="original-badge" data-testid="original-badge">
              До правок
            </span>
          )}
          {/* Клавиши 1–7 и меню «Вид» делают то же самое (ADR 0012). */}
          <div className="view-switch" role="group" aria-label="Режим просмотра" data-testid="view-mode" data-mode={viewMode}>
            {VIEW_MODES.map((mode, i) => (
              <button
                key={mode}
                aria-pressed={mode === viewMode}
                aria-label={VIEW_MODE_LABELS[mode]}
                title={`${VIEW_MODE_LABELS[mode]} — ${i + 1}`}
                onClick={() => setViewMode(mode)}
              >
                {i + 1}
              </button>
            ))}
            <span className="view-name">{VIEW_MODE_LABELS[viewMode]}</span>
          </div>
          <div className="spacer" />
          {/* Пустые позиции — в начало ленты, после закреплённых (ADR 0022). Delete удаляет выделенные пустые. */}
          <div className="grid-tools" role="group" aria-label="Позиции сетки">
            <button onClick={() => insertEmptyPositions(1)} title="Пустая позиция в начало ленты — место под будущий пост">
              + Позиция
            </button>
            <button onClick={() => insertEmptyPositions(COLUMNS)} title="Ряд из трёх пустых позиций в начало ленты">
              + Ряд пустых
            </button>
            <label className="pinned-select" title="Закреплённые посты сверху: не двигаются, вне анализа, публикуются последними">
              <select
                aria-label="Закреплено"
                data-testid="pinned-select"
                value={snapshot.project.grid.pinned}
                onChange={(e) => setPinned(Number(e.currentTarget.value))}
              >
                {PINNED_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    Закреплено: {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button onClick={() => void api.invoke('project:create')}>Новый проект</button>
          <button onClick={() => void api.invoke('project:open')}>Открыть проект</button>
          <button onClick={() => void api.invoke('project:close')}>Закрыть</button>
          <button className="primary" onClick={() => void api.invoke('assets:import')}>
            Импорт фото
          </button>
          <button onClick={openExportDialog} title="Экспорт — ⌘⇧E">
            Экспорт
          </button>
        </>
      )}
    </header>
  );
}
