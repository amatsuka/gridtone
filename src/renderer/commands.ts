// Действия пользователя над сеткой: выделение, перестановка, копирование правок, образы, команды меню.
// Проект меняется только через editProject — так каждое действие попадает в историю (ADR 0011).
import { original } from 'immer';
import { copyAdjustGroups, type AdjustGroup } from '@core/project/adjustGroups';
import { assignLook, createLook, duplicateLook, nextLookName, removeLook } from '@core/project/looks';
import { moveSlots, shiftSlots } from '@core/project/order';
import type { Adjust, Project, Slot } from '@core/project/types';
import { isValidLookName } from '@core/project/validate';
import type { MenuCommand } from '@shared/ipc';
import { isViewMode, type ViewMode } from '@shared/view';
import { clickSelection, EMPTY_SELECTION, selectAll } from './selection';
import { editProject, redo, undo, useAppStore, type InspectorTab } from './store';

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
 * Переставляет слоты. Патчи — `replace slots[i]` только для изменившихся позиций, а не весь массив:
 * иначе отмена после импорта вернула бы массив без новых слотов (ADR 0011).
 */
function reorder(arrange: (slots: readonly Slot[]) => Slot[]): void {
  editProject((draft) => {
    const base = original(draft.slots) as Slot[];
    arrange(base).forEach((slot, i) => {
      if (slot !== base[i]) draft.slots[i] = slot;
    });
  });
}

/** Отпускание при перетаскивании: блок ids встаёт на позицию to. */
export function moveTiles(ids: readonly string[], to: number): void {
  reorder((slots) => moveSlots(slots, ids, to));
}

/** Shift+стрелки: выделение сдвигается на delta позиций. */
export function shiftSelection(delta: number): void {
  const { ids, primary } = useAppStore.getState().selection;
  if (ids.length === 0) return;
  reorder((slots) => shiftSlots(slots, ids, delta));
  // Сдвинутая плитка могла уйти за край прокрутки; DOM обновится к следующему кадру.
  if (primary) {
    requestAnimationFrame(() =>
      document.querySelector(`[data-slot-id="${CSS.escape(primary)}"]`)?.scrollIntoView({ block: 'nearest' }),
    );
  }
}

// ─── Правки ─────────────────────────────────────────────────────────────────

/** Правка поправки фото у слота: ищем по id, а не по индексу — порядок мог поменяться. */
export function editSlotAdjust(slotId: string, change: (adjust: Adjust) => void, gesture?: string): void {
  editProject((draft) => {
    const slot = draft.slots.find((s) => s.id === slotId);
    if (slot) change(slot.adjust);
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

/** Опубликованные посты не перекрашиваются (spec, «Статусы позиций»). */
function applyToSlots(ids: readonly string[], source: Adjust, groups: readonly AdjustGroup[]): void {
  const targets = new Set(ids);
  editProject((draft) => {
    for (const slot of draft.slots) {
      if (targets.has(slot.id) && slot.state !== 'published') copyAdjustGroups(slot.adjust, source, groups);
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

// ─── Просмотр ───────────────────────────────────────────────────────────────

/** Клавиши 1–7, переключатель в тулбаре и меню «Вид». Режим — состояние интерфейса, не проекта. */
export function setViewMode(mode: ViewMode): void {
  if (useAppStore.getState().viewMode !== mode) useAppStore.setState({ viewMode: mode });
}

/** Удержание `\`: сетка без поправок и образов, пока клавиша нажата. */
export function setShowOriginal(show: boolean): void {
  if (useAppStore.getState().showOriginal !== show) useAppStore.setState({ showOriginal: show });
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
  if (!useAppStore.getState().snapshot || useAppStore.getState().groupsDialog) return;
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
  }
}

const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];

/** Поле, где ⌘Z, ⌘A и стрелки работают как обычно. */
export function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.includes(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}
