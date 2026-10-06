import { join } from 'node:path';
import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import type { ProjectSnapshot } from '@shared/ipc';
import { IMPORT_EXTENSIONS, type ProjectService } from './project/service';

export type Actions = ReturnType<typeof createActions>;

/** Пользовательские действия с диалогами. Их вызывают и IPC, и меню. */
export function createActions(service: ProjectService, getWindow: () => BrowserWindow | null) {
  const showOpen = (options: OpenDialogOptions) => {
    const window = getWindow();
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
  };
  const showSave = (options: SaveDialogOptions) => {
    const window = getWindow();
    return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
  };
  const showMessage = (options: MessageBoxOptions) => {
    const window = getWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  const reportError = async (message: string, err: unknown) => {
    await showMessage({ type: 'error', message, detail: err instanceof Error ? err.message : String(err) });
  };

  /** Закрывает проект; если сохранить не удалось, спрашивает, закрывать ли без сохранения. */
  const closeOrAsk = async (discardLabel: string): Promise<boolean> => {
    try {
      await service.close();
      return true;
    } catch (err) {
      const { response } = await showMessage({
        type: 'warning',
        message: 'Не удалось сохранить проект',
        detail: err instanceof Error ? err.message : String(err),
        buttons: [discardLabel, 'Отмена'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return false;
      service.discard();
      return true;
    }
  };

  return {
    async createProject(): Promise<ProjectSnapshot | null> {
      const result = await showSave({
        title: 'Новый проект',
        message: 'Проект — это папка: в ней будут project.json и cache/',
        buttonLabel: 'Создать',
        defaultPath: join(app.getPath('documents'), 'Новая сетка'),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return null;
      try {
        return await service.create(result.filePath);
      } catch (err) {
        await reportError('Не удалось создать проект', err);
        return null;
      }
    },

    async openProject(dir?: string): Promise<ProjectSnapshot | null> {
      let target = dir;
      if (target === undefined) {
        const result = await showOpen({ title: 'Открыть проект', buttonLabel: 'Открыть', properties: ['openDirectory'] });
        target = result.filePaths[0];
        if (result.canceled || target === undefined) return null;
      }
      try {
        return await service.open(target);
      } catch (err) {
        await reportError('Не удалось открыть проект', err);
        return null;
      }
    },

    async importPhotos(paths?: string[]): Promise<{ jobId: string } | null> {
      if (!service.hasProject) return null;
      let files = paths;
      if (files === undefined) {
        const result = await showOpen({
          title: 'Импорт фото',
          buttonLabel: 'Импортировать',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Изображения', extensions: IMPORT_EXTENSIONS }],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        files = result.filePaths;
      }
      const jobId = service.importFiles(files);
      return jobId === null ? null : { jobId };
    },

    async saveProject(): Promise<void> {
      try {
        await service.save();
      } catch (err) {
        await reportError('Не удалось сохранить проект', err);
      }
    },

    async closeProject(): Promise<void> {
      await closeOrAsk('Закрыть без сохранения');
    },

    /** true — можно выходить: проект сохранён или пользователь согласился выйти без сохранения. */
    prepareQuit(): Promise<boolean> {
      return closeOrAsk('Выйти без сохранения');
    },
  };
}
