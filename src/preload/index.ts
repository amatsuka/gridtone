import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type EventMap,
  type GridtoneApi,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
} from '@shared/ipc';

// Наружу уходят только каналы из shared/ipc.ts, сам ipcRenderer renderer не видит.
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api: GridtoneApi = {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>> {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Неизвестный канал: ${channel}`));
    return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<K>>;
  },
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void {
    if (!eventAllowed.has(channel)) throw new Error(`Неизвестный канал: ${channel}`);
    const handler = (_event: IpcRendererEvent, payload: EventMap[K]) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld('gridtone', api);
