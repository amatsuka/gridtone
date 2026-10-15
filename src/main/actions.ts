import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import type {
  CalibrationCheckResult,
  DecodeImageJob,
  ExportStarted,
  LutImportResult,
  PatternImage,
  PatternImageResult,
  ProjectSnapshot,
} from '@shared/ipc';
import { parseCalibrationRequest, parseExportRequest, type ExportService } from './export';
import { IMPORT_EXTENSIONS, type ProjectService } from './project/service';

export type Actions = ReturnType<typeof createActions>;

/** utility process: чтение картинки-шаблона паттерна (docs/decisions/0024-pattern-image.md). */
export interface PatternImagePort {
  decodeImage(job: Omit<DecodeImageJob, 'type'>): Promise<PatternImage>;
}

/** Пользовательские действия с диалогами. Их вызывают и IPC, и меню. */
export function createActions(
  service: ProjectService,
  exporter: ExportService,
  images: PatternImagePort,
  getWindow: () => BrowserWindow | null,
) {
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
      await exporter.plan(before.project, parsed);
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

    /**
     * «Показать в Finder» в итоге экспорта: подпапка выделяется в своей родительской папке. Путь приходит из
     * renderer, поэтому показывается только папка, которую создал экспорт в этом запуске; иначе — ошибка.
     */
    revealExport(dir: unknown): void {
      if (typeof dir !== 'string' || !exporter.isExportFolder(dir)) throw new Error('Это не папка экспорта');
      shell.showItemInFolder(dir);
    },

    /**
     * «Проверить карту…» (docs/decisions/0016-calibration-card.md): образ и его LUT проверяются до диалога,
     * затем main спрашивает карту, которую вернул редактор. Ошибки возвращаются в renderer и видны в диалоге
     * экспорта; null — отменено или проект уже другой.
     */
    async checkCalibration(request: unknown): Promise<CalibrationCheckResult | null> {
      const parsed = parseCalibrationRequest(request);
      const snapshot = service.snapshot();
      if (!snapshot || snapshot.dir !== parsed.dir) return null;
      const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
      let target: Awaited<ReturnType<ExportService['cardParams']>>;
      try {
        target = await exporter.cardParams(snapshot.project, parsed.lookId);
      } catch (err) {
        return { ok: false, error: message(err) };
      }
      const result = await showOpen({
        title: 'Проверить калибровочную карту',
        message: `Карта, которую редактор вернул с LUT образа «${target.look.name}»`,
        buttonLabel: 'Проверить',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: IMPORT_EXTENSIONS }],
        ...(exportRoot ? { defaultPath: exportRoot } : {}),
      });
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) return null;
      const file = basename(path);
      try {
        return { ok: true, file, lookName: target.look.name, report: await exporter.checkCard(path, target.params) };
      } catch (err) {
        return { ok: false, error: `${file}: ${message(err)}` };
      }
    },

    /**
     * «Из изображения…» (docs/decisions/0024-pattern-image.md): картинку-шаблон спрашивает main, читает индексатор,
     * renderer получает пиксели и сам ищет сетку. Проект не меняется; ошибка чтения возвращается в renderer.
     */
    async openPatternImage(): Promise<PatternImageResult | null> {
      if (!service.hasProject) return null;
      const result = await showOpen({
        title: 'Паттерн из изображения',
        message: 'Картинка с квадратами 3 × N: шаблон сетки, светлые и тёмные или цветные ячейки',
        buttonLabel: 'Открыть',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: IMPORT_EXTENSIONS }],
      });
      const path = result.filePaths[0];
      if (result.canceled || path === undefined || !service.hasProject) return null;
      const file = basename(path);
      try {
        return { ok: true, file, image: await images.decodeImage({ jobId: randomUUID(), path }) };
      } catch (err) {
        return { ok: false, error: `${file}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    /** «Импорт LUT…»: файл спрашивает main, ошибка разбора возвращается в renderer и показывается там. */
    async importLut(): Promise<LutImportResult | null> {
      if (!service.hasProject) return null;
      const result = await showOpen({
        title: 'Импорт LUT',
        message: 'Файл .cube станет новым образом проекта; его копия ляжет в папку проекта',
        buttonLabel: 'Импортировать',
        properties: ['openFile'],
        filters: [{ name: '3D LUT (.cube)', extensions: ['cube'] }],
      });
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) return null;
      return service.importLut(path);
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
