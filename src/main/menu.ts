import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Actions } from './actions';

const PROJECT_ITEM_IDS = ['import', 'save', 'close'];

export function buildMenu(actions: Actions): void {
  const isMac = process.platform === 'darwin';
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
    { role: 'editMenu' },
    { role: 'viewMenu' },
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
