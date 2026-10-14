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

/** Место плитки в плане публикации (planOrder, ADR 0022). Опубликованные в плане не стоят. */
export interface TilePlan {
  /** Номер в порядке публикации, с 1. */
  order: number;
  /** Закреплённая позиция: опубликовать последней и закрепить. */
  pin: boolean;
  /** В ленте ниже опубликованного: на этом месте пост не опубликовать. */
  belowPublished: boolean;
}

/**
 * Плитка сетки. Само фото рисует GridCanvas под ней; плитка отвечает за заглушку, номер, бейджи,
 * пометки статуса и номер публикации, рамку выделения. Клики и перетаскивание ловит сетка (useTileDrag).
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
  pinned,
  order,
  pin,
  belowPublished,
}: {
  slot: Slot;
  index: number;
  status: AssetStatus | undefined;
  selected: boolean;
  /** Основная плитка выделения: её правят ползунки. */
  primary: boolean;
  renderMode: 'gl' | 'img';
  overlay: TileOverlay | undefined;
  /** Закреплённая позиция (grid.pinned): не двигается и вне анализа. */
  pinned: boolean;
  /** Номер в плане публикации; undefined — опубликованный пост, в плане его нет. Остальное — как в TilePlan. */
  order: number | undefined;
  pin: boolean;
  belowPublished: boolean;
}) {
  const { assetId } = slot;
  const original = status?.original ?? 'ok';
  const ready = assetId !== undefined && status?.proxy === 'ready';
  const empty = assetId === undefined;
  const published = slot.state === 'published';
  const classes = ['tile', selected && 'selected', primary && 'primary', empty && 'empty', pinned && 'pinned'].filter(Boolean);

  return (
    <figure
      className={classes.join(' ')}
      data-testid="tile"
      data-slot-id={slot.id}
      data-asset-id={assetId}
      data-state={slot.state}
      data-pinned={pinned || undefined}
      data-order={order}
      data-pin={pin || undefined}
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
      {empty ? (
        <div className="tile-placeholder tile-empty-label">Пусто</div>
      ) : (
        !ready && <div className="tile-placeholder">{status?.proxy === 'pending' ? 'Готовим превью…' : 'Нет превью'}</div>
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
      {/* Номер публикации — в верхней полосе, как номер позиции: внизу он лёг бы на фото. */}
      {(order !== undefined || original !== 'ok') && (
        <div className="tile-corner">
          {order !== undefined && (
            <span
              className={`tile-order${belowPublished ? ' warn' : ''}`}
              data-testid="tile-order"
              title={
                belowPublished
                  ? `${order}-й в порядке публикации — но ниже опубликованного: на этом месте его не опубликовать`
                  : `${order}-й в порядке публикации${pin ? ': опубликовать и закрепить' : ''}`
              }
            >
              {order}-й{pin ? ' · закрепить' : ''}
            </span>
          )}
          {original !== 'ok' && (
            <span className="tile-badge" title={ORIGINAL_HINT[original]}>
              !
            </span>
          )}
        </div>
      )}
      {(pinned || published) && (
        <div className="tile-marks">
          {pinned && (
            <span className="tile-mark" data-testid="tile-pinned" title="Закреплённый пост: не двигается, в анализ не входит">
              Закреплён
            </span>
          )}
          {published && (
            <span className="tile-mark" data-testid="tile-published" title="Опубликован: не правится и не двигается, в анализе — контекст">
              Опубликован
            </span>
          )}
        </div>
      )}
    </figure>
  );
});
