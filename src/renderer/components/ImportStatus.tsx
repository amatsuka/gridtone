import { dismissImportProgress, useAppStore } from '../store';

export function ImportStatus() {
  const progress = useAppStore((state) => state.importProgress);
  if (!progress) return null;
  const { done, total, added, duplicates, errors, finished } = progress;

  return (
    <section className="import-status" data-testid="import-status" aria-live="polite">
      {finished ? (
        <span>
          Импорт завершён: добавлено {added}
          {duplicates > 0 && `, уже в проекте ${duplicates}`}
          {errors.length > 0 && `, ошибок ${errors.length}`}
        </span>
      ) : (
        <>
          <span>
            Импорт: {done} из {total}
          </span>
          <progress max={total} value={done} />
        </>
      )}
      {errors.length > 0 && (
        <details>
          <summary>Ошибки</summary>
          <ul>
            {errors.map((error) => (
              <li key={error.path}>
                <b>{fileName(error.path)}</b> — {error.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {finished && (
        <button className="link" onClick={dismissImportProgress}>
          Скрыть
        </button>
      )}
    </section>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
