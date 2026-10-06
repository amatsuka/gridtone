import { utilityProcess, type UtilityProcess } from 'electron';
import type { IndexJob, IndexerRequest, IndexerResponse } from '@shared/ipc';
import type { IndexerPort } from './project/service';
import indexerPath from '../indexer/index?modulePath';

interface PendingJob {
  remaining: Set<number>;
  onMessage: (message: IndexerResponse) => void;
}

/** Запускает индексатор по первому требованию и перезапускает, если он упал. */
export class IndexerClient implements IndexerPort {
  private child: UtilityProcess | null = null;
  private readonly jobs = new Map<string, PendingJob>();

  run(job: Omit<IndexJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    this.jobs.set(job.jobId, { remaining: new Set(job.items.keys()), onMessage });
    const request: IndexerRequest = { type: 'index', ...job };
    this.ensureChild().postMessage(request);
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(indexerPath, [], { serviceName: 'Gridtone Indexer' });
    child.on('message', (message: IndexerResponse) => {
      const job = this.jobs.get(message.jobId);
      if (!job) return;
      if (message.type === 'item') job.remaining.delete(message.index);
      else this.jobs.delete(message.jobId);
      job.onMessage(message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      // Всё, что не успело обработаться, завершаем ошибкой, чтобы импорт не завис.
      for (const [jobId, job] of this.jobs) {
        for (const index of job.remaining) {
          job.onMessage({ type: 'item', jobId, index, ok: false, code: 'failed', error: `Индексатор завершился (код ${code})` });
        }
        job.onMessage({ type: 'done', jobId });
      }
      this.jobs.clear();
    });
    this.child = child;
    return child;
  }
}
