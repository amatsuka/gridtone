import { create } from 'zustand';
import type { ImportProgress, ProjectSnapshot } from '@shared/ipc';

export const api = window.gridtone;

interface AppState {
  /** false, пока не пришёл первый снимок из main. */
  ready: boolean;
  snapshot: ProjectSnapshot | null;
  importProgress: ImportProgress | null;
}

export const useAppStore = create<AppState>()(() => ({
  ready: false,
  snapshot: null,
  importProgress: null,
}));

/** Подписывает стор на события main. Возвращает отписку. */
export function connectStore(): () => void {
  const offProject = api.on('project:changed', (snapshot) => {
    useAppStore.setState((state) => ({
      ready: true,
      snapshot,
      // Прогресс импорта относится к проекту: при смене проекта он больше не нужен.
      importProgress: snapshot?.dir === state.snapshot?.dir ? state.importProgress : null,
    }));
  });
  const offImport = api.on('import:progress', (importProgress) => useAppStore.setState({ importProgress }));
  void api.invoke('project:get').then((snapshot) => useAppStore.setState({ ready: true, snapshot }));
  return () => {
    offProject();
    offImport();
  };
}

export function dismissImportProgress(): void {
  useAppStore.setState({ importProgress: null });
}
