// Раскладка cache/ внутри папки проекта: общая для main (протокол, сверка кэша) и индексатора.
// Почему такие размеры и формат — docs/decisions/0004-proxies.md.

/** 2048 — по длинной стороне (редактор), 512 — по короткой (плитка сетки). */
export const PROXY_SIZES = [512, 2048] as const;
export type ProxySize = (typeof PROXY_SIZES)[number];

export const ASSET_ID_RE = /^[0-9a-f]{16}$/;

/** Путь прокси относительно cache/. */
export function proxyRelPath(assetId: string, size: ProxySize): string {
  return `proxies/${assetId}/${size}.jpg`;
}

export function proxyUrl(assetId: string, size: ProxySize): string {
  return `gridtone://proxy/${assetId}/${size}`;
}
