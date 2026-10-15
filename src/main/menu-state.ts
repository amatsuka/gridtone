// Состояние пунктов меню (docs/decisions/0011-undo-history.md, 0012-view-modes.md): какие пункты активны и какой
// режим просмотра отмечен. Чистая логика без Electron: её проверяют модульные тесты, menu.ts только переносит её
// в меню. Состоянием интерфейса владеет renderer и шлёт его каналом `menu:state`.
import { isRecord } from '@core/project/json';
import type { MenuState } from '@shared/ipc';
import { isViewMode, VIEW_MODES } from '@shared/view';

/** Пункты, которым нужен открытый проект. */
export const PROJECT_ITEM_IDS: readonly string[] = [
  'import',
  'importLut',
  'export',
  'save',
  'close',
  'undo',
  'redo',
  'copyAdjust',
  'pasteAdjust',
  'editor',
  ...VIEW_MODES.map((mode) => `view:${mode}`),
];

/** До первого сообщения renderer: история пуста, режим по умолчанию, плитка не выбрана. */
export const INITIAL_MENU_STATE: MenuState = { undo: false, redo: false, viewMode: 'grid', editor: false };

export interface MenuItemState {
  enabled: boolean;
  /** Только у пунктов «Вид»: отмечен режим, в котором сетка сейчас. */
  checked?: boolean;
}

/**
 * Состояние каждого пункта проекта: без проекта все неактивны; «Отменить», «Повторить» и «Редактор фото» —
 * ещё и по состоянию renderer. Режим отмечен и при закрытом проекте: он остаётся прежним.
 */
export function menuItemStates(hasProject: boolean, state: MenuState): Map<string, MenuItemState> {
  const only: Record<string, boolean> = { undo: state.undo, redo: state.redo, editor: state.editor };
  const items = new Map<string, MenuItemState>();
  for (const id of PROJECT_ITEM_IDS) items.set(id, { enabled: hasProject && (only[id] ?? true) });
  for (const mode of VIEW_MODES) {
    const id = `view:${mode}`;
    items.set(id, { ...(items.get(id) as MenuItemState), checked: mode === state.viewMode });
  }
  return items;
}

/** Состояние меню из renderer. Бросает, если оно не такое, каким его шлёт renderer. */
export function parseMenuState(value: unknown): MenuState {
  if (
    !isRecord(value) ||
    typeof value['undo'] !== 'boolean' ||
    typeof value['redo'] !== 'boolean' ||
    typeof value['editor'] !== 'boolean' ||
    !isViewMode(value['viewMode'])
  ) {
    throw new Error('Неверное состояние меню');
  }
  return { undo: value['undo'], redo: value['redo'], viewMode: value['viewMode'], editor: value['editor'] };
}
