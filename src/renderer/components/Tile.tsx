import type { Slot } from '@core/project/types';
import { proxyUrl } from '@shared/cache';
import type { AssetStatus } from '@shared/ipc';

const ORIGINAL_HINT: Record<Exclude<AssetStatus['original'], 'ok'>, string> = {
  missing: 'Оригинал не найден по сохранённому пути',
  changed: 'Оригинал изменился после импорта',
};

/** Плитка сетки. Кадр пока не применяется — показываем центр; кадрирование придёт с WebGL-превью. */
export function Tile({ slot, index, status }: { slot: Slot; index: number; status: AssetStatus | undefined }) {
  const { assetId } = slot;
  const original = status?.original ?? 'ok';

  return (
    <figure className="tile" data-testid="tile" data-asset-id={assetId}>
      {assetId && status?.proxy === 'ready' ? (
        <img src={proxyUrl(assetId, 512)} alt="" loading="lazy" decoding="async" draggable={false} />
      ) : (
        <div className="tile-placeholder">
          {status?.proxy === 'pending' ? 'Готовим превью…' : assetId ? 'Нет превью' : ''}
        </div>
      )}
      <span className="tile-number">{index + 1}</span>
      {original !== 'ok' && (
        <span className="tile-badge" title={ORIGINAL_HINT[original]}>
          !
        </span>
      )}
    </figure>
  );
}
