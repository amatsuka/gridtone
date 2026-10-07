// История правок для undo/redo (docs/decisions/0011-undo-history.md). Чистый TS: о патчах знает только
// то, что их можно склеить. Применяет их store.ts.

export interface HistoryEntry<P> {
  patches: P[];
  inverse: P[];
}

const DEFAULT_LIMIT = 200;

export class History<P> {
  private done: HistoryEntry<P>[] = [];
  private undone: HistoryEntry<P>[] = [];
  /** Ключ жеста последней записи, пока жест не закончен. */
  private gesture: string | null = null;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  /** Новое действие. Правка с ключом открытого жеста дописывается в его запись. */
  record(patches: P[], inverse: P[], gesture?: string): void {
    const last = this.done.at(-1);
    if (last && gesture !== undefined && gesture === this.gesture) {
      last.patches = [...last.patches, ...patches];
      last.inverse = [...inverse, ...last.inverse];
    } else {
      this.done.push({ patches, inverse });
      if (this.done.length > this.limit) this.done.shift();
    }
    this.gesture = gesture ?? null;
    this.undone = [];
  }

  /** Жест закончен: следующая правка с тем же ключом станет новой записью. */
  endGesture(): void {
    this.gesture = null;
  }

  /** Запись для отмены: применить её inverse. */
  undo(): HistoryEntry<P> | undefined {
    this.gesture = null;
    const entry = this.done.pop();
    if (entry) this.undone.push(entry);
    return entry;
  }

  /** Запись для повтора: применить её patches. */
  redo(): HistoryEntry<P> | undefined {
    this.gesture = null;
    const entry = this.undone.pop();
    if (entry) this.done.push(entry);
    return entry;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.gesture = null;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
