// Точка входа utility process: принимает задачи от main и строит прокси.
import type { IndexerRequest, IndexerResponse } from '@shared/ipc';
import { IndexError, errorMessage, indexFile } from './proxies';

const MAX_PARALLEL = 2;

const port = process.parentPort;
const queue: (() => Promise<void>)[] = [];
let active = 0;

function post(message: IndexerResponse): void {
  port.postMessage(message);
}

function pump(): void {
  while (active < MAX_PARALLEL) {
    const task = queue.shift();
    if (!task) return;
    active++;
    void task().finally(() => {
      active--;
      pump();
    });
  }
}

port.on('message', (event) => {
  const job = event.data as IndexerRequest;
  const { jobId, cacheDir, items } = job;
  let left = items.length;
  if (left === 0) {
    post({ type: 'done', jobId });
    return;
  }
  items.forEach((item, index) => {
    queue.push(async () => {
      try {
        const asset = await indexFile(item, cacheDir);
        post({ type: 'item', jobId, index, ok: true, asset });
      } catch (err) {
        const code = err instanceof IndexError ? err.code : 'failed';
        post({ type: 'item', jobId, index, ok: false, code, error: errorMessage(err) });
      }
      if (--left === 0) post({ type: 'done', jobId });
    });
  });
  pump();
});
