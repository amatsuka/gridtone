import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { create } from 'zustand';
import type { ProjectPatch } from '@core/project/patch';
import type { Project } from '@core/project/types';
import type { ImportProgress, ProjectSnapshot } from '@shared/ipc';

export const api = window.gridtone;

enablePatches();

interface AppState {
  /** false, пока не пришёл первый снимок из main. */
  ready: boolean;
  /** Проект с правками renderer, которые main, возможно, ещё не подтвердил. */
  snapshot: ProjectSnapshot | null;
  importProgress: ImportProgress | null;
  selectedSlotId: string | null;
  /** img — WebGL2 недоступен, плитки показываются картинками без коррекции. */
  renderMode: 'gl' | 'img';
}

export const useAppStore = create<AppState>()(() => ({
  ready: false,
  snapshot: null,
  importProgress: null,
  selectedSlotId: null,
  renderMode: 'gl',
}));

// Поток правок — docs/decisions/0008-edit-flow.md.
let lastSeq = 0;
/** Пакеты, отправленные в main, но ещё не вошедшие в пришедший от него снимок. */
let pending: { seq: number; patches: Patch[] }[] = [];

/** Правит проект локально, сразу показывает результат и отправляет патчи в main. */
export function editProject(recipe: (draft: Project) => void): void {
  const { snapshot } = useAppStore.getState();
  if (!snapshot) return;
  const [project, patches] = produceWithPatches(snapshot.project, recipe);
  if (patches.length === 0) return;
  const seq = ++lastSeq;
  pending.push({ seq, patches });
  useAppStore.setState({ snapshot: { ...snapshot, project } });
  api.invoke('project:patch', { dir: snapshot.dir, seq, patches: patches as ProjectPatch[] }).catch((err: unknown) => {
    console.error('main отверг правку', err);
    // Своя копия разошлась с main: берём его проект целиком.
    if (useAppStore.getState().snapshot?.dir === snapshot.dir) void resync();
  });
}

async function resync(): Promise<void> {
  pending = [];
  receiveSnapshot(await api.invoke('project:get'));
}

/** Снимок из main + свои пакеты, которых в нём ещё нет. */
function receiveSnapshot(incoming: ProjectSnapshot | null): void {
  const current = useAppStore.getState();
  if (!incoming || incoming.dir !== current.snapshot?.dir) pending = [];
  pending = pending.filter((p) => incoming && p.seq > incoming.patchSeq);
  let snapshot = incoming;
  if (snapshot && pending.length > 0) {
    let project = snapshot.project;
    for (const p of pending) project = applyPatches(project, p.patches);
    snapshot = { ...snapshot, project };
  }
  const selectedSlotId =
    snapshot && snapshot.project.slots.some((slot) => slot.id === current.selectedSlotId) ? current.selectedSlotId : null;
  useAppStore.setState({
    ready: true,
    snapshot,
    selectedSlotId,
    // Прогресс импорта относится к проекту: при смене проекта он больше не нужен.
    importProgress: snapshot?.dir === current.snapshot?.dir ? current.importProgress : null,
  });
}

/** Подписывает стор на события main. Возвращает отписку. */
export function connectStore(): () => void {
  const offProject = api.on('project:changed', receiveSnapshot);
  const offStatus = api.on('project:status', ({ dir, save, patchSeq }) => {
    const { snapshot } = useAppStore.getState();
    if (snapshot?.dir !== dir) return;
    // Подтверждённые пакеты больше не нужны для наложения на будущие снимки.
    pending = pending.filter((p) => p.seq > patchSeq);
    useAppStore.setState({ snapshot: { ...snapshot, save } });
  });
  const offImport = api.on('import:progress', (importProgress) => useAppStore.setState({ importProgress }));
  void api.invoke('project:get').then(receiveSnapshot);
  return () => {
    offProject();
    offStatus();
    offImport();
  };
}

export function selectSlot(slotId: string | null): void {
  useAppStore.setState({ selectedSlotId: slotId });
}

export function dismissImportProgress(): void {
  useAppStore.setState({ importProgress: null });
}
