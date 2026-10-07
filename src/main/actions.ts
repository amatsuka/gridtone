import { join } from 'node:path';
import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import type { ExportStarted, ProjectSnapshot } from '@shared/ipc';
import { parseExportRequest, type ExportService } from './export';
import { IMPORT_EXTENSIONS, type ProjectService } from './project/service';

export type Actions = ReturnType<typeof createActions>;

/** Пользовательские действия с диалогами. Их вызывают и IPC, и меню. */
export function createActions(service: ProjectService, exporter: ExportService, getWindow: () => BrowserWindow | null) {
  /** Папка последнего экспорта: диалог открывается в ней. Только до выхода из приложения. */
  let exportRoot: string | undefined;

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

    /**
     * Экспорт из диалога renderer: запрос проверяется до выбора папки, затем main создаёт подпапку
     * и запускает запекание. Бросает, если запрос неверный — renderer его так не составит.
     */
    async exportProject(request: unknown): Promise<ExportStarted | null> {
      const parsed = parseExportRequest(request);
      const before = service.snapshot();
      if (!before || before.dir !== parsed.dir) return null;
      exporter.plan(before.project, parsed);
      const result = await showOpen({
        title: 'Папка для экспорта',
        message: 'Файлы лягут в новую подпапку: старые экспорты не перезаписываются',
        buttonLabel: 'Экспортировать',
        properties: ['openDirectory', 'createDirectory'],
        ...(exportRoot ? { defaultPath: exportRoot } : { defaultPath: app.getPath('pictures') }),
      });
      const root = result.filePaths[0];
      if (result.canceled || root === undefined) return null;
      // Пока был открыт диалог, проект могли закрыть.
      const snapshot = service.snapshot();
      if (!snapshot || snapshot.dir !== parsed.dir) return null;
      try {
        const started = await exporter.start(root, snapshot.project, parsed);
        exportRoot = root;
        return started;
      } catch (err) {
        await reportError('Не удалось начать экспорт', err);
        return null;
      }
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
