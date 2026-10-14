// Действия пользователя над сеткой: выделение, перестановка, копирование правок, образы, редактор фото, команды меню.
// Проект меняется только через editProject — так каждое действие попадает в историю (ADR 0011).
import { original } from 'immer';
import { applyFix, type TileFix } from '@core/harmony/fixes';
import type { GeneratorParams } from '@core/pattern/generator';
import { clearTargets, targetsAgree, withPatternTargets } from '@core/pattern/pattern';
import { copyAdjustGroups, type AdjustGroup } from '@core/project/adjustGroups';
import { cloneJson, sameJson } from '@core/project/json';
import { assignLook, createLook, duplicateLook, nextLookName, removeLook } from '@core/project/looks';
import { moveSlots, shiftSlots } from '@core/project/order';
import { assignSlots, insertEmptySlots, isEmptySlot, removeEmptySlots, setPublished } from '@core/project/slots';
import type { Adjust, Crop, Pattern, Project, Slot } from '@core/project/types';
import { isValidLookName, PINNED_MAX } from '@core/project/validate';
import type { MenuCommand } from '@shared/ipc';
import { isViewMode, type ViewMode } from '@shared/view';
import type { PatternDraft } from './pattern';
import { clickSelection, EMPTY_SELECTION, selectAll } from './selection';
import { api, editProject, redo, undo, useAppStore, type EditorTab, type InspectorTab } from './store';

function project(): Project | undefined {
  return useAppStore.getState().snapshot?.project;
}

function order(): string[] {
  return project()?.slots.map((slot) => slot.id) ?? [];
}

/** Слот, который правят ползунки: основная плитка выделения. */
export function primarySlot(): Slot | undefined {
  const { snapshot, selection } = useAppStore.getState();
  return snapshot?.project.slots.find((slot) => slot.id === selection.primary);
}

// ─── Выделение ──────────────────────────────────────────────────────────────

/** replace — клик, toggle — ⌘-клик, range — Shift-клик. Вкладка «Образ» следует за образом основной плитки. */
export function clickTile(slotId: string, mode: 'replace' | 'toggle' | 'range'): void {
  const { selection, activeLookId } = useAppStore.getState();
  const next = clickSelection(selection, order(), slotId, mode);
  const lookId = project()?.slots.find((slot) => slot.id === next.primary)?.lookId;
  useAppStore.setState({ selection: next, activeLookId: lookId ?? activeLookId });
}

/** Клик по клетке карты яркости во вкладке «Анализ»: то же выделение, и сетка прокручивается к плитке. */
export function clickTileInAnalysis(slotId: string, mode: 'replace' | 'toggle' | 'range'): void {
  clickTile(slotId, mode);
  scrollToTile(slotId);
}

export function selectAllTiles(): void {
  useAppStore.setState((state) => ({ selection: selectAll(state.selection, order()) }));
}

export function clearSelection(): void {
  useAppStore.setState({ selection: EMPTY_SELECTION });
}

export function setInspectorTab(tab: InspectorTab): void {
  useAppStore.setState({ inspectorTab: tab });
}

// ─── Порядок ────────────────────────────────────────────────────────────────

/**
 * Переписывает порядок и состав слотов. Патчи — `replace slots[i]` только для изменившихся позиций и add или
 * remove в хвосте, а не весь массив: иначе отмена после импорта вернула бы массив без новых слотов (ADR 0011, 0022).
 * Цели — свойство позиции (ADR 0023): в той же правке каждая позиция получает свою клетку паттерна, а без
 * паттерна — свою прежнюю цель. Одна запись истории — и порядок, и цели.
 */
function rewriteSlots(arrange: (slots: readonly Slot[], pinned: number) => Slot[]): void {
  editProject((draft) => {
    const base = original(draft.slots) as Slot[];
    const { pattern, grid } = original(draft) as Project;
    assignSlots(draft.slots, base, withPatternTargets(arrange(base, grid.pinned), pattern, grid.pinned, base));
  });
}

/** Отпускание при перетаскивании: блок ids встаёт на позицию to; одна плитка на пустой позиции — обмен. */
export function moveTiles(ids: readonly string[], to: number): void {
  rewriteSlots((slots, pinned) => moveSlots(slots, ids, to, pinned));
}

/** Shift+стрелки: выделение сдвигается на delta позиций. Закреплённые и опубликованные стоят на месте. */
export function shiftSelection(delta: number): void {
  const { ids, primary } = useAppStore.getState().selection;
  if (ids.length === 0) return;
  rewriteSlots((slots, pinned) => shiftSlots(slots, ids, delta, pinned));
  // Сдвинутая плитка могла уйти за край прокрутки; DOM обновится к следующему кадру.
  if (primary) scrollToTile(primary);
}

// ─── Статусы, пустые позиции и закреплённые (docs/decisions/0022-statuses-empty-pinned.md) ───

/** «Опубликован» во вкладке «Фото»: статус всех выделенных позиций с фото одной записью истории. */
export function setSelectionPublished(published: boolean): void {
  const { ids } = useAppStore.getState().selection;
  if (ids.length > 0) editProject((draft) => setPublished(draft, ids, published));
}

/** «+ Позиция» и «+ Ряд пустых»: пустые позиции в начало ленты, сразу после закреплённых, одной записью. */
export function insertEmptyPositions(count: number): void {
  if (!project()) return;
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  rewriteSlots((slots, pinned) => insertEmptySlots(slots, ids, pinned));
}

/** Delete и Backspace: выделенные пустые позиции удаляются одной записью; плитки с фото остаются. */
export function removeSelectedEmpty(): void {
  const current = project();
  const { ids } = useAppStore.getState().selection;
  const selected = new Set(ids);
  if (!current?.slots.some((slot) => selected.has(slot.id) && isEmptySlot(slot))) return;
  rewriteSlots((slots) => removeEmptySlots(slots, ids));
}

/**
 * «Закреплено: 0–3» в тулбаре: первые n позиций — закреплённые посты, вне ленты и анализа. Закреплённые цели
 * не получают, откреплённые получают свою клетку паттерна — в той же записи истории (ADR 0023).
 */
export function setPinned(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > PINNED_MAX) return;
  editProject((draft) => {
    if (draft.grid.pinned === n) return;
    draft.grid.pinned = n as Project['grid']['pinned'];
    const base = original(draft.slots) as Slot[];
    assignSlots(draft.slots, base, withPatternTargets(base, (original(draft) as Project).pattern, n, base));
  });
}

// ─── Паттерн и цели позиций (docs/decisions/0023-patterns.md) ─────────────────

/** Черновик паттерна во вкладке «Цель» — состояние интерфейса, в проект не пишется. */
export function editPatternDraft(change: Partial<PatternDraft>): void {
  useAppStore.setState((state) => ({ patternDraft: { ...state.patternDraft, ...change } }));
}

export function editGeneratorParams(change: Partial<GeneratorParams>): void {
  useAppStore.setState((state) => ({
    patternDraft: { ...state.patternDraft, generator: { ...state.patternDraft.generator, ...change } },
  }));
}

/** «Применить к сетке»: паттерн и цели всех позиций — одна запись истории. Тот же паттерн повторно ничего не пишет. */
export function applyPatternToGrid(pattern: Pattern): void {
  const current = project();
  if (!current) return;
  if (sameJson(current.pattern, pattern) && targetsAgree(current.slots, pattern, current.grid.pinned)) return;
  editProject((draft) => {
    draft.pattern = cloneJson(pattern);
    const base = original(draft.slots) as Slot[];
    assignSlots(draft.slots, base, withPatternTargets(base, pattern, draft.grid.pinned, base));
  });
}

/** «Убрать цели»: ни паттерна, ни целей у позиций — режим 7 и выбросы снова сверяют плитки с сеткой. */
export function clearPattern(): void {
  editProject((draft) => {
    if (draft.pattern) delete draft.pattern;
    const base = original(draft.slots) as Slot[];
    assignSlots(draft.slots, base, clearTargets(base));
  });
}

function scrollToTile(slotId: string): void {
  requestAnimationFrame(() => document.querySelector(`[data-slot-id="${CSS.escape(slotId)}"]`)?.scrollIntoView({ block: 'nearest' }));
}

// ─── Правки ─────────────────────────────────────────────────────────────────

/** Позицию правят ползунки и кадр: с фото и не опубликованная (spec, «Статусы позиций»; ADR 0022). */
const editable = (slot: Slot) => !isEmptySlot(slot) && slot.state !== 'published';

/** Правка поправки фото у слота: ищем по id, а не по индексу — порядок мог поменяться. */
export function editSlotAdjust(slotId: string, change: (adjust: Adjust) => void, gesture?: string): void {
  editProject((draft) => {
    const slot = draft.slots.find((s) => s.id === slotId);
    if (slot && editable(slot)) change(slot.adjust);
  }, gesture);
}

/**
 * «Применить» поправку выброса (ADR 0021): значение ползунка — в поправку фото, одна запись истории.
 * Значение абсолютное, поэтому повторное нажатие ничего не меняет. Опубликованные не правятся.
 */
export function applyTileFix(slotId: string, fix: TileFix): void {
  if (fix.replace) return;
  editProject((draft) => {
    const slot = draft.slots.find((s) => s.id === slotId);
    if (slot && editable(slot)) applyFix(slot.adjust, fix);
  });
}

/** Правка кадра слота: редактор фото. Один жест мыши — одна запись истории. */
export function editSlotCrop(slotId: string, change: (crop: Crop) => void, gesture?: string): void {
  editProject((draft) => {
    const slot = draft.slots.find((s) => s.id === slotId);
    if (slot && editable(slot)) change(slot.crop);
  }, gesture);
}

export function editLookAdjust(lookId: string, change: (adjust: Adjust) => void, gesture?: string): void {
  editProject((draft) => {
    const look = draft.looks.find((l) => l.id === lookId);
    if (look) change(look.adjust);
  }, gesture);
}

/** ⌘⇧C и «Синхронизировать» сначала спрашивают группы. */
export function openGroupsDialog(mode: 'copy' | 'sync'): void {
  if (primarySlot()) useAppStore.setState({ groupsDialog: mode });
}

export function closeGroupsDialog(): void {
  useAppStore.setState({ groupsDialog: null });
}

/** Запоминает выбранные группы поправки основной плитки. Проект не меняется. */
export function copyAdjust(groups: readonly AdjustGroup[]): void {
  const slot = primarySlot();
  if (slot) useAppStore.setState({ clipboard: { adjust: slot.adjust, groups } });
}

/** ⌘⇧V: скопированные группы — во всё выделение одним действием. */
export function pasteAdjust(): void {
  const { clipboard, selection } = useAppStore.getState();
  if (clipboard && clipboard.groups.length > 0) applyToSlots(selection.ids, clipboard.adjust, clipboard.groups);
}

/** «Синхронизировать»: группы основной плитки переносятся на остальные выделенные. */
export function syncAdjust(groups: readonly AdjustGroup[]): void {
  const slot = primarySlot();
  const { selection } = useAppStore.getState();
  if (slot && groups.length > 0) applyToSlots(selection.ids.filter((id) => id !== slot.id), slot.adjust, groups);
}

/** Опубликованные посты не перекрашиваются (spec, «Статусы позиций»), у пустых позиций коррекции нет. */
function applyToSlots(ids: readonly string[], source: Adjust, groups: readonly AdjustGroup[]): void {
  const targets = new Set(ids);
  editProject((draft) => {
    for (const slot of draft.slots) {
      if (targets.has(slot.id) && editable(slot)) copyAdjustGroups(slot.adjust, source, groups);
    }
  });
}

// ─── Образы ─────────────────────────────────────────────────────────────────

/** Новый образ — пустой или с копией поправки основной плитки. Сразу открывается для правки. */
export function newLook(fromPhoto: boolean): void {
  const id = crypto.randomUUID();
  const adjust = fromPhoto ? primarySlot()?.adjust : undefined;
  if (fromPhoto && !adjust) return;
  editProject((draft) => void draft.looks.push(createLook(id, nextLookName(draft.looks), adjust)));
  useAppStore.setState({ activeLookId: id, inspectorTab: 'look' });
}

export function duplicateLookById(lookId: string): void {
  const id = crypto.randomUUID();
  editProject((draft) => void duplicateLook(draft, lookId, id));
  if (project()?.looks.some((look) => look.id === id)) useAppStore.setState({ activeLookId: id });
}

export function removeLookById(lookId: string): void {
  editProject((draft) => removeLook(draft, lookId));
  const next = project()?.looks[0]?.id ?? null;
  useAppStore.setState({ activeLookId: next });
}

/** Пустое и слишком длинное имя не принимается: поле вернёт прежнее. */
export function renameLook(lookId: string, name: string): void {
  const trimmed = name.trim();
  if (!isValidLookName(trimmed)) return;
  editProject((draft) => {
    const look = draft.looks.find((l) => l.id === lookId);
    if (look && look.name !== trimmed) look.name = trimmed;
  });
}

export function setActiveLook(lookId: string | null): void {
  useAppStore.setState({ activeLookId: lookId });
}

/** Назначает образ выделению; null снимает любой образ. */
export function assignLookToSelection(lookId: string | null): void {
  const { ids } = useAppStore.getState().selection;
  if (ids.length > 0) editProject((draft) => assignLook(draft, ids, lookId));
}

// ─── LUT образов (docs/decisions/0015-lut-import.md) ────────────────────────

/**
 * «Импорт LUT…» и «Файл → Импортировать LUT…»: файл спрашивает main, новый образ появляется в конце
 * списка и сразу открывается. Импорт в историю не входит, как импорт фото. Ошибка — во вкладке «Образ».
 */
export async function importLut(): Promise<void> {
  if (!project()) return;
  const result = await api.invoke('lut:import');
  if (!result) return;
  if (!result.ok) {
    useAppStore.setState({ lutImportError: result.error, inspectorTab: 'look' });
    return;
  }
  useAppStore.setState({ activeLookId: result.lookId, inspectorTab: 'look', lutImportError: null });
}

export function dismissLutImportError(): void {
  useAppStore.setState({ lutImportError: null });
}

/** «Снять LUT»: обычная правка, отменяется ⌘Z. Запись реестра остаётся — на ней держится отмена. */
export function detachLut(lookId: string): void {
  editProject((draft) => {
    const look = draft.looks.find((l) => l.id === lookId);
    if (look && look.importedLut !== undefined) delete look.importedLut;
  });
}

// ─── Редактор фото ──────────────────────────────────────────────────────────

/** Посты с фото в порядке сетки: по ним ходят ←/→ в редакторе. */
function photoSlots(): Slot[] {
  return project()?.slots.filter((slot) => slot.assetId !== undefined) ?? [];
}

/**
 * E и двойной щелчок по плитке: редактор основной плитки. Позиция без фото не открывается.
 * Если открывают не основную плитку, она становится выделенной — правки копируются с того, что видно.
 */
export function openEditor(slotId: string | null = useAppStore.getState().selection.primary): void {
  const slot = photoSlots().find((s) => s.id === slotId);
  if (!slot) return;
  if (useAppStore.getState().selection.primary !== slot.id) clickTile(slot.id, 'replace');
  useAppStore.setState({ editorSlotId: slot.id });
}

/** Esc и «Готово»: сетка прокручивается к посту, на котором закрыли редактор. */
export function closeEditor(): void {
  const { editorSlotId } = useAppStore.getState();
  if (!editorSlotId) return;
  useAppStore.setState({ editorSlotId: null });
  scrollToTile(editorSlotId);
}

/** ←/→ в редакторе: соседний пост с фото. Выделение следует за редактором. */
export function stepEditor(delta: -1 | 1): void {
  const { editorSlotId } = useAppStore.getState();
  const photos = photoSlots();
  const next = photos[photos.findIndex((slot) => slot.id === editorSlotId) + delta];
  if (!editorSlotId || !next) return;
  clickTile(next.id, 'replace');
  useAppStore.setState({ editorSlotId: next.id });
}

export function setEditorTab(tab: EditorTab): void {
  useAppStore.setState({ editorTab: tab });
}

// ─── Просмотр ───────────────────────────────────────────────────────────────

/** Клавиши 1–7, переключатель в тулбаре и меню «Вид». Режим — состояние интерфейса, не проекта. */
export function setViewMode(mode: ViewMode): void {
  if (useAppStore.getState().viewMode !== mode) useAppStore.setState({ viewMode: mode });
}

/** Удержание `\`: сетка без поправок и образов, пока клавиша нажата. */
export function setShowOriginal(show: boolean): void {
  if (useAppStore.getState().showOriginal !== show) useAppStore.setState({ showOriginal: show });
}

// ─── Экспорт ────────────────────────────────────────────────────────────────

/** ⌘⇧E, кнопка «Экспорт» и меню «Файл → Экспорт…». Диалог над всем окном, в том числе над редактором. */
export function openExportDialog(): void {
  if (useAppStore.getState().snapshot) useAppStore.setState({ exportOpen: true, groupsDialog: null });
}

export function closeExportDialog(): void {
  useAppStore.setState({ exportOpen: false });
}

// ─── Меню ───────────────────────────────────────────────────────────────────

/**
 * Команда меню или сочетание клавиш. Если фокус в текстовом поле, «Отменить», «Повторить» и
 * «Выделить всё» относятся к тексту, а не к проекту.
 */
export function runMenuCommand(command: MenuCommand): void {
  if (isTextField(document.activeElement) && (command === 'undo' || command === 'redo' || command === 'selectAll')) {
    // execCommand устарел, но другого способа вызвать правку текста из страницы нет.
    document.execCommand(command);
    return;
  }
  const { snapshot, groupsDialog, exportOpen } = useAppStore.getState();
  if (!snapshot || groupsDialog || exportOpen) return;
  if (command.startsWith('view:')) {
    const mode = command.slice('view:'.length);
    if (isViewMode(mode)) setViewMode(mode);
    return;
  }
  switch (command) {
    case 'undo':
      undo();
      break;
    case 'redo':
      redo();
      break;
    case 'selectAll':
      selectAllTiles();
      break;
    case 'copyAdjust':
      openGroupsDialog('copy');
      break;
    case 'pasteAdjust':
      pasteAdjust();
      break;
    case 'export':
      openExportDialog();
      break;
    case 'importLut':
      void importLut();
      break;
  }
}

const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];

/** Поле, где ⌘Z, ⌘A и стрелки работают как обычно. */
export function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}
