import { join } from 'node:path';
import { proxyRelPath, type ProxySize } from '@shared/cache';

// Папка проекта: project.json, project.json.bak (предыдущее сохранение) и cache/.

export const projectFile = (dir: string): string => join(dir, 'project.json');
export const backupFile = (dir: string): string => join(dir, 'project.json.bak');
export const cacheDir = (dir: string): string => join(dir, 'cache');
export const proxyFile = (dir: string, assetId: string, size: ProxySize): string =>
  join(cacheDir(dir), proxyRelPath(assetId, size));
