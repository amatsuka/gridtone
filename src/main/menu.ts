import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand, MenuState } from '@shared/ipc';
import { VIEW_MODE_LABELS, VIEW_MODES } from '@shared/view';
import type { Actions } from './actions';
import { INITIAL_MENU_STATE, menuItemStates } from './menu-state';

let hasProject = false;
let menuState: MenuState = INITIAL_MENU_STATE;

/**
 * sendCommand передаёт команду в renderer: undo/redo и правки ведёт он (docs/decisions/0011-undo-history.md).
 * В текстовом поле renderer выполняет «Отменить» и «Выделить всё» как правку текста.
 */
export function buildMenu(actions: Actions, sendCommand: (command: MenuCommand) => void): void {
  const isMac = process.platform === 'darwin';
  const command = (id: MenuCommand, label: string, accelerator: string): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => sendCommand(id),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Новый проект…', accelerator: 'CmdOrCtrl+N', click: () => void actions.createProject() },
        { label: 'Открыть проект…', accelerator: 'CmdOrCtrl+O', click: () => void actions.openProject() },
        { type: 'separator' },
        { id: 'import', label: 'Импортировать фото…', accelerator: 'CmdOrCtrl+I', click: () => void actions.importPhotos() },
        // Импорт LUT ведёт renderer: он показывает ошибку разбора и открывает новый образ.
        { id: 'importLut', label: 'Импортировать LUT…', click: () => sendCommand('importLut') },
        // Диалог экспорта живёт в renderer: меню только открывает его.
        command('export', 'Экспорт…', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        { id: 'save', label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => void actions.saveProject() },
        { id: 'close', label: 'Закрыть проект', accelerator: 'CmdOrCtrl+Shift+W', click: () => void actions.closeProject() },
        ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        command('undo', 'Отменить', 'CmdOrCtrl+Z'),
        command('redo', 'Повторить', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        // Роли нужны текстовым полям: на macOS без них ⌘X, ⌘C и ⌘V в полях не работают.
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        command('selectAll', 'Выделить всё', 'CmdOrCtrl+A'),
        { type: 'separator' },
        command('copyAdjust', 'Копировать правки…', 'CmdOrCtrl+Shift+C'),
        command('pasteAdjust', 'Вставить правки', 'CmdOrCtrl+Shift+V'),
      ],
    },
    {
      label: 'Вид',
      submenu: [
        // Клавиши 1–7 и E ловит renderer, вне полей ввода. Зарегистрированные в меню, они перехватили бы
        // цифры и буквы и в поле имени образа, поэтому здесь они только подписаны.
        // Отмеченный режим — тот, о котором сообщил renderer. Electron отмечает пункт radio сам ещё до click;
        // если renderer команду не выполнит (открыт диалог), отметка вернётся к его режиму.
        ...VIEW_MODES.map(
          (mode, i): MenuItemConstructorOptions => ({
            ...command(`view:${mode}`, VIEW_MODE_LABELS[mode], String(i + 1)),
            type: 'radio',
            checked: mode === menuState.viewMode,
            registerAccelerator: false,
            click: () => {
              sendCommand(`view:${mode}`);
              applyMenuState();
            },
          }),
        ),
        { type: 'separator' },
        { ...command('editor', 'Редактор фото', 'E'), registerAccelerator: false },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'forceReload', label: 'Перезагрузить без кэша' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Фактический размер' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  applyMenuState();
}

/** Открыт ли проект: без него пункты проекта неактивны. */
export function setProjectMenuEnabled(enabled: boolean): void {
  hasProject = enabled;
  applyMenuState();
}

/** Состояние интерфейса из renderer: история, режим просмотра, выбранная плитка. */
export function setMenuState(state: MenuState): void {
  menuState = state;
  applyMenuState();
}

function applyMenuState(): void {
  const menu = Menu.getApplicationMenu();
  for (const [id, { enabled, checked }] of menuItemStates(hasProject, menuState)) {
    const item = menu?.getMenuItemById(id);
    if (!item) continue;
    item.enabled = enabled;
    // У radio присваивание отмечает пункт и снимает отметку с остальных в группе — даже false. Поэтому только true.
    if (checked) item.checked = true;
  }
}
