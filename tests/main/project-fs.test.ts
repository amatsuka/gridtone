import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createProject } from '@core/project/defaults';
import { ProjectFormatError } from '@core/project/serialize';
import { createProjectFolder, readProjectFile, writeProjectFile } from '../../src/main/project/fs';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridtone-fs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('папка проекта', () => {
  test('создаёт project.json и cache/proxies', async () => {
    const dir = join(root, 'Сетка');
    await createProjectFolder(dir, createProject('Сетка'));
    expect((await stat(join(dir, 'cache', 'proxies'))).isDirectory()).toBe(true);
    expect(await readProjectFile(dir)).toStrictEqual(createProject('Сетка'));
  });

  test('не создаёт проект в непустой папке, но .DS_Store не мешает', async () => {
    const busy = join(root, 'busy');
    await mkdir(busy);
    await writeFile(join(busy, 'notes.txt'), '');
    await expect(createProjectFolder(busy, createProject('x'))).rejects.toThrow(/не пуста/);

    const mac = join(root, 'mac');
    await mkdir(mac);
    await writeFile(join(mac, '.DS_Store'), '');
    await createProjectFolder(mac, createProject('x'));
  });

  test('сохранение оставляет предыдущую версию в .bak и не оставляет временных файлов', async () => {
    const dir = join(root, 'p');
    const project = createProject('Первая');
    await createProjectFolder(dir, project);
    const first = await readFile(join(dir, 'project.json'), 'utf8');

    project.name = 'Вторая';
    await writeProjectFile(dir, project);

    expect(await readFile(join(dir, 'project.json.bak'), 'utf8')).toBe(first);
    expect((await readProjectFile(dir)).name).toBe('Вторая');
    expect((await readdir(dir)).sort()).toEqual(['cache', 'project.json', 'project.json.bak']);
  });

  test('понятная ошибка, если это не проект', async () => {
    await expect(readProjectFile(root)).rejects.toThrow(/нет project.json/);
  });

  test('битый project.json не принимается', async () => {
    await writeFile(join(root, 'project.json'), '{"version":1');
    await expect(readProjectFile(root)).rejects.toThrow(ProjectFormatError);
  });
});
