import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc';

/** Типизированный обработчик канала из shared/ipc.ts. Принимает вызовы только от своего renderer. */
export function handle<K extends InvokeChannel>(
  channel: K,
  handler: (...args: InvokeArgs<K>) => Promise<InvokeResult<K>> | InvokeResult<K>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(...(args as InvokeArgs<K>));
  });
}

export function send<K extends EventChannel>(window: BrowserWindow | null, channel: K, payload: EventMap[K]): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const trusted = devUrl ? url.startsWith(new URL(devUrl).origin) : url.startsWith('file://');
  if (!trusted) throw new Error(`IPC-вызов из недоверенного источника: ${url}`);
}
