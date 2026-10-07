import { memo } from 'react';
import type { Slot } from '@core/project/types';
import { proxyUrl } from '@shared/cache';
import type { AssetStatus } from '@shared/ipc';
import { selectSlot } from '../store';

const ORIGINAL_HINT: Record<Exclude<AssetStatus['original'], 'ok'>, string> = {
  missing: 'Оригинал не найден по сохранённому пути',
  changed: 'Оригинал изменился после импорта',
};

/**
 * Плитка сетки. Само фото рисует GridCanvas под ней; плитка отвечает за заглушку, номер, бейджи
 * и выбор. Когда холст нарисовал фото, GridRenderer ставит плитке data-rendered.
 * Без WebGL фото показывается картинкой — без коррекции и кадра.
 */
export const Tile = memo(function Tile({
  slot,
  index,
  status,
  selected,
  renderMode,
}: {
  slot: Slot;
  index: number;
  status: AssetStatus | undefined;
  selected: boolean;
  renderMode: 'gl' | 'img';
}) {
  const { assetId } = slot;
  const original = status?.original ?? 'ok';
  const ready = assetId !== undefined && status?.proxy === 'ready';

  return (
    <figure
      className={`tile${selected ? ' selected' : ''}`}
      data-testid="tile"
      data-slot-id={slot.id}
      data-asset-id={assetId}
      aria-selected={selected}
      onClick={() => selectSlot(slot.id)}
    >
      {ready && renderMode === 'img' && (
        <img
          src={proxyUrl(assetId, 512)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(e) => (e.currentTarget.parentElement as HTMLElement).setAttribute('data-rendered', 'true')}
        />
      )}
      {!ready && (
        <div className="tile-placeholder">{status?.proxy === 'pending' ? 'Готовим превью…' : assetId ? 'Нет превью' : ''}</div>
      )}
      <span className="tile-number">{index + 1}</span>
      {original !== 'ok' && (
        <span className="tile-badge" title={ORIGINAL_HINT[original]}>
          !
        </span>
      )}
    </figure>
  );
});
