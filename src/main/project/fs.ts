import { access, copyFile, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProject, serializeProject } from '@core/project/serialize';
import type { Project } from '@core/project/types';
import { backupFile, cacheDir, projectFile } from './paths';

/** Создаёт папку проекта. Папка должна быть новой или пустой. */
export async function createProjectFolder(dir: string, project: Project): Promise<void> {
  const entries = await readdir(dir).catch((err: unknown) => {
    if (isErrno(err, 'ENOENT')) return [];
    throw err;
  });
  if (entries.some((name) => name !== '.DS_Store')) {
    throw new Error(`Папка ${dir} не пуста. Для нового проекта нужна пустая папка.`);
  }
  await mkdir(join(cacheDir(dir), 'proxies'), { recursive: true });
  await writeProjectFile(dir, project);
}

export async function readProjectFile(dir: string): Promise<Project> {
  let text: string;
  try {
    text = await readFile(projectFile(dir), 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new Error(`В папке ${dir} нет project.json — это не проект Gridtone.`);
    throw err;
  }
  return parseProject(text);
}

/**
 * Атомарная запись: новый файл пишется рядом и fsync-ится, предыдущая версия
 * копируется в project.json.bak, затем rename заменяет project.json целиком.
 */
export async function writeProjectFile(dir: string, project: Project): Promise<void> {
  const target = projectFile(dir);
  const tmp = `${target}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(serializeProject(project), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await copyFile(target, backupFile(dir)).catch((err: unknown) => {
    if (!isErrno(err, 'ENOENT')) throw err;
  });
  await rename(tmp, target);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}
