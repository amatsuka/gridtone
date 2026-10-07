// Горячие клавиши сетки и команды меню. Клавиши — по event.code: иначе в русской раскладке
// ⌘Z пришёл бы как «я». Обработанное сочетание гасится preventDefault, и меню его уже не получит
// (docs/decisions/0011-undo-history.md).
import { VIEW_MODES, type ViewMode } from '@shared/view';
import { api, endGesture, useAppStore } from './store';
import {
  clearSelection,
  closeEditor,
  isTextField,
  openEditor,
  runMenuCommand,
  setShowOriginal,
  setViewMode,
  shiftSelection,
  stepEditor,
} from './commands';

const COLUMNS = 3;

const SHIFT_BY_ARROW: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -COLUMNS,
  ArrowDown: COLUMNS,
};

/** Digit1…Digit7 и те же цифры на цифровом блоке → режим просмотра. */
const VIEW_BY_CODE: Record<string, ViewMode> = Object.fromEntries(
  VIEW_MODES.flatMap((mode, i) => [
    [`Digit${i + 1}`, mode],
    [`Numpad${i + 1}`, mode],
  ]),
);

/** До/после — удержание `\`. По event.code, как и остальные: символ на этой клавише зависит от раскладки. */
const ORIGINAL_CODE = 'Backslash';

/** ←/→ в редакторе фото — соседний пост. */
const STEP_BY_ARROW: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowRight: 1 };

function onKeyDown(event: KeyboardEvent): void {
  const { snapshot, groupsDialog, editorSlotId } = useAppStore.getState();
  const editor = editorSlotId !== null;
  // Диалог групп обрабатывает клавиши сам.
  if (event.defaultPrevented || event.isComposing || !snapshot || groupsDialog) return;
  const mod = event.metaKey || event.ctrlKey;
  const text = isTextField(event.target);
  // Стрелки в ползунке и выпадающем списке двигают их, а не плитки.
  const control = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || text;
  const delta = SHIFT_BY_ARROW[event.code];
  const view = VIEW_BY_CODE[event.code];
  const plain = !mod && !event.altKey && !event.shiftKey;

  if (mod && !event.altKey && event.code === 'KeyZ' && !text) {
    runMenuCommand(event.shiftKey ? 'redo' : 'undo');
  } else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyC') {
    runMenuCommand('copyAdjust');
  } else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyV') {
    runMenuCommand('pasteAdjust');
  } else if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyA' && !text) {
    runMenuCommand('selectAll');
  } else if (!mod && event.code === 'Escape' && !text) {
    // Esc сначала закрывает редактор фото, затем снимает выделение.
    if (editor) closeEditor();
    else clearSelection();
  } else if (editor && plain && STEP_BY_ARROW[event.code] !== undefined && !control) {
    stepEditor(STEP_BY_ARROW[event.code] as -1 | 1);
  } else if (!editor && event.shiftKey && !mod && !event.altKey && delta !== undefined && !control) {
    // В редакторе посты не переставляются: соседи под ←/→ остаются теми же.
    shiftSelection(delta);
  } else if (!editor && plain && event.code === 'KeyE' && !text) {
    openEditor();
  } else if (plain && view !== undefined && !text && !(event.target instanceof HTMLSelectElement)) {
    setViewMode(view);
  } else if (plain && event.code === ORIGINAL_CODE && !text) {
    setShowOriginal(true);
  } else {
    return;
  }
  event.preventDefault();
}

/** Подписывает окно на клавиши и меню. Возвращает отписку. */
export function connectShortcuts(): () => void {
  // Любое отпускание кнопки мыши или клавиши заканчивает жест: следующая правка — новая запись истории.
  const onRelease = () => endGesture();
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === ORIGINAL_CODE) setShowOriginal(false);
  };
  // Окно потеряло фокус с зажатой `\`: keyup уже не придёт.
  const onBlur = () => setShowOriginal(false);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('keyup', onRelease, true);
  const offMenu = api.on('menu:command', runMenuCommand);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('keyup', onRelease, true);
    offMenu();
  };
}
