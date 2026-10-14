// Точка входа utility process: принимает задачи от main — строит прокси, экспортирует LUT, калибровочную
// карту, посты и сетку, проверяет возвращённую карту, читает картинку-шаблон паттерна.
import type { IndexJob, IndexerRequest, IndexerResponse } from '@shared/ipc';
import { runCardCheck } from './calibration';
import { runExport } from './export';
import { runDecodeImage } from './patternImage';
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

/** Экспорты идут по одному, отдельно от очереди импорта. */
let exportQueue = Promise.resolve();

port.on('message', (event) => {
  const request = event.data as IndexerRequest;
  if (request.type === 'export') {
    exportQueue = exportQueue.then(() => runExport(request, post)).catch((err: unknown) => {
      post({ type: 'file', jobId: request.jobId, file: '', ok: false, error: errorMessage(err) });
      post({ type: 'done', jobId: request.jobId });
    });
    return;
  }
  // Проверка карты — одна картинка, доли секунды: без очереди.
  if (request.type === 'check-card') {
    void runCardCheck(request, post);
    return;
  }
  // Картинка-шаблон — одна картинка, как и карта: без очереди.
  if (request.type === 'decode-image') {
    void runDecodeImage(request, post);
    return;
  }
  index(request);
});

function index(job: IndexJob): void {
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
}
