// Состояние пунктов меню из состояния интерфейса (docs/decisions/0011-undo-history.md, 0012-view-modes.md):
// renderer шлёт его в main каналом `menu:state`, main включает и отмечает пункты. Чистая функция без DOM и стора:
// фокус в текстовом поле приходит флагом.
import type { Slot } from '@core/project/types';
import type { MenuState } from '@shared/ipc';
import type { ViewMode } from '@shared/view';

export interface MenuInputs {
  /** Слоты проекта; без проекта — пусто: пункты проекта main и так выключит. */
  slots: readonly Pick<Slot, 'id' | 'assetId'>[];
  /** Основная плитка выделения. */
  primary: string | null;
  editorSlotId: string | null;
  /** Открыт диалог групп, экспорт или импорт паттерна: команды проекта renderer не выполняет (runMenuCommand). */
  modal: boolean;
  canUndo: boolean;
  canRedo: boolean;
  viewMode: ViewMode;
  /** Фокус в текстовом поле: «Отменить» и «Повторить» правят текст, история проекта ни при чём. */
  textField: boolean;
}

/**
 * «Отменить» и «Повторить» — когда в истории есть правка или фокус в текстовом поле: в поле ⌘Z выполняет пункт
 * меню (ADR 0011), и выключенный пункт перестал бы отменять ввод. «Редактор фото» — когда основная плитка с фото,
 * а редактор ещё закрыт: как клавиша E.
 */
export function menuStateOf(input: MenuInputs): MenuState {
  const photo = input.slots.some((slot) => slot.id === input.primary && slot.assetId !== undefined);
  return {
    undo: input.textField || (!input.modal && input.canUndo),
    redo: input.textField || (!input.modal && input.canRedo),
    viewMode: input.viewMode,
    editor: !input.modal && input.editorSlotId === null && photo,
  };
}

export function sameMenuState(a: MenuState, b: MenuState): boolean {
  return a.undo === b.undo && a.redo === b.redo && a.viewMode === b.viewMode && a.editor === b.editor;
}
