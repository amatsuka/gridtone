import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createActions } from './actions';
import { ExportService } from './export';
import { IndexerClient } from './indexer-client';
import { handle, send } from './ipc';
import { buildMenu, setProjectMenuEnabled } from './menu';
import { ProjectService } from './project/service';
import { parsePatchBatch } from './patch-batch';
import { handleGridtoneProtocol, registerGridtoneScheme } from './protocol';

registerGridtoneScheme();

let mainWindow: BrowserWindow | null = null;

const indexer = new IndexerClient();
const service = new ProjectService(indexer, {
  snapshot: (snapshot) => {
    send(mainWindow, 'project:changed', snapshot);
    setProjectMenuEnabled(snapshot !== null);
  },
  status: (status) => send(mainWindow, 'project:status', status),
  importProgress: (progress) => send(mainWindow, 'import:progress', progress),
});
const exporter = new ExportService(indexer, (progress) => send(mainWindow, 'export:progress', progress), { luts: service });
const actions = createActions(service, exporter, () => mainWindow);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: 'Gridtone',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}

function registerIpc(): void {
  handle('project:create', () => actions.createProject());
  handle('project:open', (dir) => actions.openProject(typeof dir === 'string' ? dir : undefined));
  handle('project:get', () => service.snapshot());
  handle('project:save', () => actions.saveProject());
  handle('project:close', () => actions.closeProject());
  handle('project:patch', (batch) => service.applyPatches(parsePatchBatch(batch)));
  handle('assets:import', (paths) =>
    actions.importPhotos(Array.isArray(paths) && paths.every((p) => typeof p === 'string') ? paths : undefined),
  );
  handle('export:run', (request) => actions.exportProject(request));
  handle('calibration:check', (request) => actions.checkCalibration(request));
  handle('lut:import', () => actions.importLut());
  handle('lut:data', (id) => service.lutData(id));
}

void app.whenReady().then(() => {
  handleGridtoneProtocol((assetId, size) => service.proxyPath(assetId, size));
  registerIpc();
  buildMenu(actions, (command) => send(mainWindow, 'menu:command', command));
  setProjectMenuEnabled(false);
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Перед выходом дописываем автосохранение; при ошибке записи спрашиваем пользователя.
let quitting: Promise<boolean> | null = null;
let quitConfirmed = false;
app.on('before-quit', (event) => {
  if (quitConfirmed) return;
  event.preventDefault();
  quitting ??= actions.prepareQuit().finally(() => {
    quitting = null;
  });
  void quitting.then((ok) => {
    if (!ok || quitConfirmed) return;
    quitConfirmed = true;
    indexer.dispose();
    app.quit();
  });
});
