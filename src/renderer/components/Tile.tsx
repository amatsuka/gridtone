import { memo } from 'react';
import type { Slot } from '@core/project/types';
import { proxyUrl } from '@shared/cache';
import type { AssetStatus } from '@shared/ipc';

/** Заливка DOM-слоя в режимах 5 и 7 (ADR 0012, 0020): закрывает фото на холсте. */
export interface TileOverlay {
  kind: 'dominant' | 'deviation' | 'no-target';
  /** CSS-цвет заливки. */
  color: string;
  text?: string;
  /** Отклонение от ожидания в долях допуска. */
  value?: number;
  /** Откуда ожидание: цель позиции или сетка (ADR 0020). */
  source?: 'target' | 'grid';
  /** Подсказка: источник ожидания и части отклонения. */
  title?: string;
}

const ORIGINAL_HINT: Record<Exclude<AssetStatus['original'], 'ok'>, string> = {
  missing: 'Оригинал не найден по сохранённому пути',
  changed: 'Оригинал изменился после импорта',
};

/**
 * Плитка сетки. Само фото рисует GridCanvas под ней; плитка отвечает за заглушку, номер, бейджи
 * и рамку выделения. Клики и перетаскивание ловит сетка (useTileDrag).
 * Когда холст нарисовал фото, GridRenderer ставит плитке data-rendered.
 * Без WebGL фото показывается картинкой — без коррекции и кадра.
 */
export const Tile = memo(function Tile({
  slot,
  index,
  status,
  selected,
  primary,
  renderMode,
  overlay,
}: {
  slot: Slot;
  index: number;
  status: AssetStatus | undefined;
  selected: boolean;
  /** Основная плитка выделения: её правят ползунки. */
  primary: boolean;
  renderMode: 'gl' | 'img';
  overlay: TileOverlay | undefined;
}) {
  const { assetId } = slot;
  const original = status?.original ?? 'ok';
  const ready = assetId !== undefined && status?.proxy === 'ready';

  return (
    <figure
      className={`tile${selected ? ' selected' : ''}${primary ? ' primary' : ''}`}
      data-testid="tile"
      data-slot-id={slot.id}
      data-asset-id={assetId}
      data-primary={primary || undefined}
      aria-selected={selected}
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
      {overlay && (
        <div
          className={`tile-fill tile-fill-${overlay.kind}`}
          data-testid="tile-fill"
          data-kind={overlay.kind}
          data-value={overlay.value}
          data-source={overlay.source}
          title={overlay.title}
          style={{ backgroundColor: overlay.color }}
        >
          {overlay.text !== undefined && <span className="tile-fill-text">{overlay.text}</span>}
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
});
