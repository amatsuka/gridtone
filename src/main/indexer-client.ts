import { utilityProcess, type UtilityProcess } from 'electron';
import type { IndexJob, IndexerRequest, IndexerResponse, LutExportJob } from '@shared/ipc';
import type { LutExportPort } from './export';
import type { IndexerPort } from './project/service';
import indexerPath from '../indexer/index?modulePath';

interface PendingJob {
  onMessage: (message: IndexerResponse) => void;
  /** Процесс завершился, не ответив 'done': задача должна закончиться ошибкой, а не зависнуть. */
  onExit: (code: number) => void;
}

/** Запускает utility process по первому требованию и перезапускает, если он упал. Импорт и экспорт LUT. */
export class IndexerClient implements IndexerPort, LutExportPort {
  private child: UtilityProcess | null = null;
  private readonly jobs = new Map<string, PendingJob>();

  run(job: Omit<IndexJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    const remaining = new Set(job.items.keys());
    this.start({ type: 'index', ...job }, {
      onMessage: (message) => {
        if (message.type === 'item') remaining.delete(message.index);
        onMessage(message);
      },
      // Всё, что не успело обработаться, завершаем ошибкой, чтобы импорт не завис.
      onExit: (code) => {
        for (const index of remaining) {
          onMessage({ type: 'item', jobId: job.jobId, index, ok: false, code: 'failed', error: `Индексатор завершился (код ${code})` });
        }
        onMessage({ type: 'done', jobId: job.jobId });
      },
    });
  }

  exportLuts(job: Omit<LutExportJob, 'type'>, onMessage: (message: IndexerResponse) => void): void {
    this.start({ type: 'export-lut', ...job }, {
      onMessage,
      onExit: (code) => {
        onMessage({ type: 'file', jobId: job.jobId, file: '', ok: false, error: `Процесс экспорта завершился (код ${code})` });
        onMessage({ type: 'done', jobId: job.jobId });
      },
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }

  private start(request: IndexerRequest, job: PendingJob): void {
    this.jobs.set(request.jobId, job);
    this.ensureChild().postMessage(request);
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(indexerPath, [], { serviceName: 'Gridtone Indexer' });
    child.on('message', (message: IndexerResponse) => {
      const job = this.jobs.get(message.jobId);
      if (!job) return;
      if (message.type === 'done') this.jobs.delete(message.jobId);
      job.onMessage(message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      const jobs = [...this.jobs.values()];
      this.jobs.clear();
      for (const job of jobs) job.onExit(code);
    });
    this.child = child;
    return child;
  }
}
