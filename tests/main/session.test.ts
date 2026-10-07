import { describe, expect, test, vi } from 'vitest';
import { createProject } from '@core/project/defaults';
import type { Project } from '@core/project/types';
import { ProjectSession } from '../../src/main/project/session';

function setup(write: (dir: string, project: Project) => Promise<void>, autosaveDelayMs = 20) {
  const onChange = vi.fn();
  const session = new ProjectSession('/p', createProject('p'), {}, { write, onChange, autosaveDelayMs });
  return { session, onChange };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('автосохранение', () => {
  test('серия изменений записывается одним сохранением после паузы', async () => {
    const write = vi.fn(async () => {});
    const { session } = setup(write);
    session.update((p) => void (p.name = 'a'));
    session.update((p) => void (p.name = 'b'));
    session.update((p) => void (p.name = 'c'));
    expect(session.snapshot().save.state).toBe('pending');
    expect(write).not.toHaveBeenCalled();

    await sleep(60);
    expect(write).toHaveBeenCalledTimes(1);
    expect(session.snapshot().save.state).toBe('saved');
  });

  test('flush пишет сразу, не дожидаясь паузы', async () => {
    const write = vi.fn(async () => {});
    const { session } = setup(write, 10_000);
    session.update((p) => void (p.name = 'x'));
    await session.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(session.snapshot().save.state).toBe('saved');
  });

  test('без изменений ничего не пишется', async () => {
    const write = vi.fn(async () => {});
    const { session } = setup(write);
    await session.close();
    expect(write).not.toHaveBeenCalled();
  });

  test('ошибка записи видна в состоянии, flush бросает, следующее изменение пробует снова', async () => {
    let fail = true;
    const write = vi.fn(async () => {
      if (fail) throw new Error('диск занят');
    });
    const { session } = setup(write, 10_000);
    session.update((p) => void (p.name = 'x'));
    await expect(session.flush()).rejects.toThrow('диск занят');
    expect(session.snapshot().save).toEqual({ state: 'error', error: 'диск занят' });

    fail = false;
    session.update((p) => void (p.name = 'y'));
    await session.flush();
    expect(session.snapshot().save).toEqual({ state: 'saved' });
  });

  test('записи не идут параллельно, а изменение во время записи не теряется', async () => {
    let active = 0;
    let maxActive = 0;
    const written: string[] = [];
    const write = vi.fn(async (_dir: string, project: Project) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      written.push(project.name);
      active--;
    });
    const { session } = setup(write, 1);
    session.update((p) => void (p.name = 'first'));
    await sleep(5); // запись first идёт
    session.update((p) => void (p.name = 'second'));
    await Promise.all([session.flush(), session.flush()]);

    expect(maxActive).toBe(1);
    expect(written.at(-1)).toBe('second');
    expect(session.snapshot().save.state).toBe('saved');
  });
});

describe('правки из renderer', () => {
  test('помечают проект к сохранению, но полный снимок обратно не уходит', async () => {
    const write = vi.fn(async () => {});
    const { session, onChange } = setup(write);
    session.update((p) => void (p.name = 'из renderer'), { patchSeq: 7 });
    expect(onChange).toHaveBeenLastCalledWith('status');
    expect(session.snapshot()).toMatchObject({ patchSeq: 7, save: { state: 'pending' } });
    expect(session.status()).toEqual({ dir: '/p', save: { state: 'pending' }, patchSeq: 7 });

    session.update((p) => void (p.name = 'из main'));
    expect(onChange).toHaveBeenLastCalledWith('project');
    expect(session.snapshot().patchSeq).toBe(7);

    await sleep(60);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('status');
  });

  test('ошибка в изменении не помечает проект изменённым', () => {
    const { session, onChange } = setup(async () => {});
    expect(() =>
      session.update(() => {
        throw new Error('нельзя');
      }, { patchSeq: 1 }),
    ).toThrow('нельзя');
    expect(onChange).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({ patchSeq: 0, save: { state: 'saved' } });
  });
});
