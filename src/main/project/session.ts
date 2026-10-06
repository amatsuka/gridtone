import type { Project } from '@core/project/types';
import type { AssetStatus, ProjectSnapshot, SaveState } from '@shared/ipc';

export interface SessionOptions {
  write: (dir: string, project: Project) => Promise<void>;
  onChange: () => void;
  autosaveDelayMs: number;
}

/**
 * Открытый проект в памяти main. Каждое изменение сразу уходит в renderer,
 * а на диск — автосохранением с задержкой (docs/decisions/0005-autosave.md).
 * Записи никогда не идут параллельно.
 */
export class ProjectSession {
  private saveState: SaveState = 'saved';
  private saveError: string | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private closed = false;

  constructor(
    readonly dir: string,
    readonly project: Project,
    readonly assets: Record<string, AssetStatus>,
    private readonly options: SessionOptions,
  ) {}

  /** Изменить проект. Вся работа с проектом идёт через этот метод, иначе изменение не сохранится. */
  update(change: (project: Project, assets: Record<string, AssetStatus>) => void): void {
    change(this.project, this.assets);
    this.dirty = true;
    if (this.saveState !== 'error') this.saveState = 'pending';
    this.schedule();
    this.options.onChange();
  }

  /** Изменить только статусы ассетов: они не хранятся в project.json. */
  setAssetStatus(id: string, patch: Partial<AssetStatus>): void {
    const current = this.assets[id];
    if (!current) return;
    this.assets[id] = { ...current, ...patch };
    this.options.onChange();
  }

  /** Записать несохранённое немедленно. Бросает, если запись не удалась. */
  async flush(): Promise<void> {
    this.cancelTimer();
    // while, а не if: параллельный flush мог уже начать новую запись, её тоже надо дождаться.
    while (this.saving) await this.saving;
    if (this.dirty) await this.save();
    if (this.saveState === 'error') throw new Error(this.saveError ?? 'Не удалось сохранить проект');
  }

  /** Сохранить и закрыть. */
  async close(): Promise<void> {
    await this.flush();
    this.dispose();
  }

  /** Закрыть без записи — только по явному выбору пользователя после ошибки сохранения. */
  dispose(): void {
    this.cancelTimer();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  snapshot(): ProjectSnapshot {
    return {
      dir: this.dir,
      project: this.project,
      assets: this.assets,
      save: this.saveError === undefined ? { state: this.saveState } : { state: this.saveState, error: this.saveError },
    };
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Ошибку уже видно в saveState; следующее изменение попробует снова.
      this.flush().catch(() => {});
    }, this.options.autosaveDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private save(): Promise<void> {
    this.dirty = false;
    this.setSaveState('saving');
    const saving = this.options.write(this.dir, this.project).then(
      () => this.setSaveState(this.dirty ? 'pending' : 'saved'),
      (err: unknown) => {
        this.dirty = true;
        this.setSaveState('error', err instanceof Error ? err.message : String(err));
      },
    );
    this.saving = saving.finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }

  private setSaveState(state: SaveState, error?: string): void {
    if (state === this.saveState && error === this.saveError) return;
    this.saveState = state;
    this.saveError = error;
    if (!this.closed) this.options.onChange();
  }
}
