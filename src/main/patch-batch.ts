import type { ProjectPatch } from '@core/project/patch';
import type { PatchBatch } from '@shared/ipc';

const OPS: readonly unknown[] = ['replace', 'add', 'remove'];

/** Проверяет форму пакета из renderer. Что именно можно менять, решает applyProjectPatches. */
export function parsePatchBatch(value: unknown): PatchBatch {
  if (typeof value !== 'object' || value === null) throw new Error('Пакет правок: не объект');
  const { dir, seq, patches } = value as Record<string, unknown>;
  if (typeof dir !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || !Array.isArray(patches)) {
    throw new Error('Пакет правок: некорректные поля');
  }
  for (const patch of patches as unknown[]) {
    const p = patch as Partial<ProjectPatch> | null;
    const pathOk = Array.isArray(p?.path) && p.path.every((k) => typeof k === 'string' || typeof k === 'number');
    if (typeof p !== 'object' || p === null || !OPS.includes(p.op) || !pathOk) {
      throw new Error('Пакет правок: некорректный патч');
    }
  }
  return { dir, seq, patches: patches as ProjectPatch[] };
}
