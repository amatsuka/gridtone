// Пункты меню следуют за интерфейсом (docs/decisions/0011-undo-history.md, 0012-view-modes.md): история, режим
// просмотра, выбранная плитка и фокус в текстовом поле → `menu:state` в main. Шлётся только изменившееся состояние.
import type { MenuState } from '@shared/ipc';
import { isTextField } from './commands';
import { menuStateOf, sameMenuState } from './menuState';
import { api, useAppStore } from './store';

/** Подписывает меню на стор и фокус. Возвращает отписку. */
export function connectMenu(): () => void {
  let sent: MenuState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = () => {
    timer = undefined;
    const state = useAppStore.getState();
    const next = menuStateOf({
      slots: state.snapshot?.project.slots ?? [],
      primary: state.selection.primary,
      editorSlotId: state.editorSlotId,
      modal: state.groupsDialog !== null || state.exportOpen || state.patternImport !== null,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      viewMode: state.viewMode,
      textField: isTextField(document.activeElement),
    });
    if (sent && sameMenuState(sent, next)) return;
    sent = next;
    api.invoke('menu:state', next).catch((err: unknown) => console.error('Меню не обновилось', err));
  };
  // Фокус уходит из поля раньше, чем приходит в следующее, а стор меняется на каждом шаге ползунка:
  // всё это за одну задачу — одно сообщение.
  const schedule = () => {
    timer ??= setTimeout(update, 0);
  };

  const unsubscribe = useAppStore.subscribe(schedule);
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', schedule);
  update();
  return () => {
    unsubscribe();
    window.removeEventListener('focusin', schedule);
    window.removeEventListener('focusout', schedule);
    clearTimeout(timer);
  };
}
