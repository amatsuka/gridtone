import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { create } from 'zustand';
import type { AdjustGroup } from '@core/project/adjustGroups';
import type { ProjectPatch } from '@core/project/patch';
import type { Adjust, Project } from '@core/project/types';
import type { ExportProgress, ImportProgress, ProjectSnapshot } from '@shared/ipc';
import type { ViewMode } from '@shared/view';
import { History } from './history';
import { EMPTY_SELECTION, pruneSelection, type Selection } from './selection';

export const api = window.gridtone;

enablePatches();

/** Вкладки инспектора: поправка фото, образы и анализ сетки (ADR 0018). */
export type InspectorTab = 'photo' | 'look' | 'analysis';
export type EditorTab = 'color' | 'crop';

/** Скопированные правки: коррекция основной плитки на момент копирования и выбранные группы. */
export interface AdjustClipboard {
  adjust: Adjust;
  groups: readonly AdjustGroup[];
}

interface AppState {
  /** false, пока не пришёл первый снимок из main. */
  ready: boolean;
  /** Проект с правками renderer, которые main, возможно, ещё не подтвердил. */
  snapshot: ProjectSnapshot | null;
  importProgress: ImportProgress | null;
  /** img — WebGL2 недоступен, плитки показываются картинками без коррекции. */
  renderMode: 'gl' | 'img';
  selection: Selection;
  inspectorTab: InspectorTab;
  /** Образ, открытый во вкладке «Образ». */
  activeLookId: string | null;
  /** Порядок плиток, пока одну из них тянут: меняется только превью, проект — при отпускании. */
  dragOrder: readonly string[] | null;
  clipboard: AdjustClipboard | null;
  /** Открытый диалог выбора групп правок. */
  groupsDialog: 'copy' | 'sync' | null;
  /** Режим просмотра сетки, клавиши 1–7. В проект не пишется (ADR 0012). */
  viewMode: ViewMode;
  /** Удерживается `\`: сетка без поправок и образов. */
  showOriginal: boolean;
  /** Слот, открытый в редакторе фото; null — редактор закрыт. Состояние интерфейса, как и вкладка. */
  editorSlotId: string | null;
  editorTab: EditorTab;
  /** Открыт диалог «Экспорт» (⌘⇧E, кнопка в тулбаре, меню «Файл»). */
  exportOpen: boolean;
  /** Последнее событие экспорта из main: диалог показывает его, если это его задача. */
  exportProgress: ExportProgress | null;
  /** Почему не импортировался `.cube`: показывается во вкладке «Образ» (ADR 0015). */
  lutImportError: string | null;
}

export const useAppStore = create<AppState>()(() => ({
  ready: false,
  snapshot: null,
  importProgress: null,
  renderMode: 'gl',
  selection: EMPTY_SELECTION,
  inspectorTab: 'photo',
  activeLookId: null,
  dragOrder: null,
  clipboard: null,
  groupsDialog: null,
  viewMode: 'grid',
  showOriginal: false,
  editorSlotId: null,
  editorTab: 'color',
  exportOpen: false,
  exportProgress: null,
  lutImportError: null,
}));

// Поток правок — docs/decisions/0008-edit-flow.md, история — docs/decisions/0011-undo-history.md.
let lastSeq = 0;
/** Пакеты, отправленные в main, но ещё не вошедшие в пришедший от него снимок. */
let pending: { seq: number; patches: Patch[] }[] = [];
const history = new History<Patch>();

/**
 * Правит проект локально, сразу показывает результат, пишет действие в историю и отправляет патчи
 * в main. Правки с одним ключом gesture склеиваются в одну запись истории, пока жест не закончен.
 */
export function editProject(recipe: (draft: Project) => void, gesture?: string): void {
  const { snapshot } = useAppStore.getState();
  if (!snapshot) return;
  const [project, patches, inverse] = produceWithPatches(snapshot.project, recipe);
  if (patches.length === 0) return;
  history.record(patches, inverse, gesture);
  commit(snapshot, project, patches);
}

/** Жест закончен (отпущена кнопка мыши или клавиша): следующая правка — новая запись истории. */
export function endGesture(): void {
  history.endGesture();
}

export function undo(): void {
  const { snapshot } = useAppStore.getState();
  const entry = snapshot ? history.undo() : undefined;
  if (snapshot && entry) commit(snapshot, applyPatches(snapshot.project, entry.inverse), entry.inverse);
}

export function redo(): void {
  const { snapshot } = useAppStore.getState();
  const entry = snapshot ? history.redo() : undefined;
  if (snapshot && entry) commit(snapshot, applyPatches(snapshot.project, entry.patches), entry.patches);
}

/**
 * Показывает новую версию проекта и отправляет патчи в main обычным пакетом. Удалённые пустые позиции
 * (и вставленные, если их убрала отмена) уходят из выделения.
 */
function commit(snapshot: ProjectSnapshot, project: Project, patches: Patch[]): void {
  const seq = ++lastSeq;
  pending.push({ seq, patches });
  const { selection } = useAppStore.getState();
  useAppStore.setState({
    snapshot: { ...snapshot, project },
    selection: project.slots === snapshot.project.slots ? selection : pruneSelection(selection, project.slots.map((slot) => slot.id)),
  });
  api.invoke('project:patch', { dir: snapshot.dir, seq, patches: patches as ProjectPatch[] }).catch((err: unknown) => {
    console.error('main отверг правку', err);
    // Своя копия разошлась с main: берём его проект целиком.
    if (useAppStore.getState().snapshot?.dir === snapshot.dir) void resync();
  });
}

async function resync(): Promise<void> {
  pending = [];
  // Старые патчи истории к проекту main могут не подойти.
  history.clear();
  receiveSnapshot(await api.invoke('project:get'));
}

/** Снимок из main + свои пакеты, которых в нём ещё нет. */
function receiveSnapshot(incoming: ProjectSnapshot | null): void {
  const current = useAppStore.getState();
  const sameProject = incoming !== null && incoming.dir === current.snapshot?.dir;
  if (!sameProject) {
    pending = [];
    history.clear();
  }
  pending = pending.filter((p) => incoming && p.seq > incoming.patchSeq);
  let snapshot = incoming;
  if (snapshot && pending.length > 0) {
    let project = snapshot.project;
    for (const p of pending) project = applyPatches(project, p.patches);
    snapshot = { ...snapshot, project };
  }
  const order = snapshot?.project.slots.map((slot) => slot.id) ?? [];
  const lookKept = sameProject && snapshot?.project.looks.some((look) => look.id === current.activeLookId);
  const editorKept = sameProject && snapshot?.project.slots.some((slot) => slot.id === current.editorSlotId && slot.assetId);
  useAppStore.setState({
    ready: true,
    snapshot,
    selection: sameProject ? pruneSelection(current.selection, order) : EMPTY_SELECTION,
    activeLookId: lookKept ? current.activeLookId : null,
    // Превью перетаскивания пересчитается при следующем движении уже с новыми слотами.
    dragOrder: null,
    groupsDialog: sameProject ? current.groupsDialog : null,
    editorSlotId: editorKept ? current.editorSlotId : null,
    // Прогресс импорта относится к проекту: при смене проекта он больше не нужен.
    importProgress: sameProject ? current.importProgress : null,
    exportOpen: sameProject ? current.exportOpen : false,
    lutImportError: sameProject ? current.lutImportError : null,
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
  const offExport = api.on('export:progress', (exportProgress) => useAppStore.setState({ exportProgress }));
  void api.invoke('project:get').then(receiveSnapshot);
  return () => {
    offProject();
    offStatus();
    offImport();
    offExport();
  };
}

export function dismissImportProgress(): void {
  useAppStore.setState({ importProgress: null });
}
