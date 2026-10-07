import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@shared/ipc';
import { VIEW_MODE_LABELS, VIEW_MODES } from '@shared/view';
import type { Actions } from './actions';

const PROJECT_ITEM_IDS = [
  'import',
  'save',
  'close',
  'undo',
  'redo',
  'copyAdjust',
  'pasteAdjust',
  ...VIEW_MODES.map((mode) => `view:${mode}`),
];

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
        // Клавиши 1–7 ловит renderer, вне полей ввода. Зарегистрированные в меню, они перехватили бы
        // цифры и в поле имени образа, поэтому здесь они только подписаны.
        ...VIEW_MODES.map(
          (mode, i): MenuItemConstructorOptions => ({
            ...command(`view:${mode}`, VIEW_MODE_LABELS[mode], String(i + 1)),
            registerAccelerator: false,
          }),
        ),
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
}

export function setProjectMenuEnabled(enabled: boolean): void {
  const menu = Menu.getApplicationMenu();
  for (const id of PROJECT_ITEM_IDS) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = enabled;
  }
}
