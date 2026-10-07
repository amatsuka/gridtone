// Горячие клавиши сетки и команды меню. Клавиши — по event.code: иначе в русской раскладке
// ⌘Z пришёл бы как «я». Обработанное сочетание гасится preventDefault, и меню его уже не получит
// (docs/decisions/0011-undo-history.md).
import { api, endGesture, useAppStore } from './store';
import { clearSelection, isTextField, runMenuCommand, shiftSelection } from './commands';

const COLUMNS = 3;

const SHIFT_BY_ARROW: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -COLUMNS,
  ArrowDown: COLUMNS,
};

function onKeyDown(event: KeyboardEvent): void {
  const { snapshot, groupsDialog } = useAppStore.getState();
  // Диалог групп обрабатывает клавиши сам.
  if (event.defaultPrevented || event.isComposing || !snapshot || groupsDialog) return;
  const mod = event.metaKey || event.ctrlKey;
  const text = isTextField(event.target);
  // Стрелки в ползунке и выпадающем списке двигают их, а не плитки.
  const control = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || text;
  const delta = SHIFT_BY_ARROW[event.code];

  if (mod && !event.altKey && event.code === 'KeyZ' && !text) {
    runMenuCommand(event.shiftKey ? 'redo' : 'undo');
  } else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyC') {
    runMenuCommand('copyAdjust');
  } else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyV') {
    runMenuCommand('pasteAdjust');
  } else if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyA' && !text) {
    runMenuCommand('selectAll');
  } else if (!mod && event.code === 'Escape' && !text) {
    clearSelection();
  } else if (event.shiftKey && !mod && !event.altKey && delta !== undefined && !control) {
    shiftSelection(delta);
  } else {
    return;
  }
  event.preventDefault();
}

/** Подписывает окно на клавиши и меню. Возвращает отписку. */
export function connectShortcuts(): () => void {
  // Любое отпускание кнопки мыши или клавиши заканчивает жест: следующая правка — новая запись истории.
  const onRelease = () => endGesture();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('keyup', onRelease, true);
  const offMenu = api.on('menu:command', runMenuCommand);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('keyup', onRelease, true);
    offMenu();
  };
}
