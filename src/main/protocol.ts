import { readFile } from 'node:fs/promises';
import { protocol } from 'electron';
import type { ProxySize } from '@shared/cache';

const SCHEME = 'gridtone';
const PROXY_PATH_RE = /^\/([0-9a-f]{16})\/(512|2048)$/;

/** Вызывается до app.ready. corsEnabled — чтобы WebGL на следующих этапах принимал прокси как текстуры. */
export function registerGridtoneScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/**
 * gridtone://proxy/<assetId>/<512|2048> → файл прокси из cache/ открытого проекта.
 * Произвольные пути не принимаются: только id ассета, который есть в проекте.
 */
export function handleGridtoneProtocol(resolveProxy: (assetId: string, size: ProxySize) => string | null): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const match = url.hostname === 'proxy' ? PROXY_PATH_RE.exec(url.pathname) : null;
    const file = match ? resolveProxy(match[1] ?? '', Number(match[2]) as ProxySize) : null;
    if (!file) return notFound();
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), {
        headers: {
          'content-type': 'image/jpeg',
          // Имя файла задаёт хэш содержимого оригинала, поэтому ответ не меняется.
          'cache-control': 'public, max-age=31536000, immutable',
          'access-control-allow-origin': '*',
        },
      });
    } catch {
      return notFound();
    }
  });
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}
