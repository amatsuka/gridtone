// Превью периода паттерна и устойчивость к сдвигу (docs/decisions/0023-patterns.md): общие для вкладки «Цель» и
// «Импорта паттерна» (ADR 0024). Клетки и режим публикации считает core.
import { POSTING_MODE_LABELS, singlePostShift } from '@core/pattern/pattern';
import type { Pattern, SlotTarget } from '@core/project/types';
import { targetCss } from '../pattern';
import { plural } from '../plural';

/** Период паттерна образцами: 3 × periodRows, левый верхний — позиция 0. Мягкая цель — с пунктирной рамкой. */
export function PatternPreview({ pattern }: { pattern: Pattern }) {
  return (
    <div className="pattern-preview" data-testid="pattern-preview" data-rows={pattern.periodRows} data-cells={pattern.cells.length}>
      {pattern.cells.map((cell, i) => (
        <span
          key={i}
          className={cell.hard ? 'pattern-cell' : 'pattern-cell soft'}
          data-testid="pattern-cell"
          data-l={cell.L}
          data-hue={cell.hue}
          data-chroma={cell.chroma}
          data-hard={cell.hard}
          style={{ backgroundColor: targetCss(cell), color: cell.L > 0.62 ? '#111' : '#eee' }}
          title={targetTitle(cell)}
        >
          {cell.L.toFixed(2)}
        </span>
      ))}
    </div>
  );
}

export function targetTitle(target: SlotTarget): string {
  const color = target.hue !== undefined ? `, тон ${Math.round(target.hue)}°` : '';
  const chroma = target.chroma !== undefined ? `, хрома ${target.chroma.toFixed(3)}` : '';
  return `L ${target.L.toFixed(2)}${color}${chroma}${target.hard ? '' : ' — мягкая'}`;
}

/** Устойчивость к сдвигу с пояснением. */
export function PostingModeNote({ pattern }: { pattern: Pattern }) {
  const shift = singlePostShift(pattern.cells);
  const explanation =
    shift === null
      ? 'Новый пост сдвигает ленту на позицию, и этот паттерн разваливается. Публикуйте по три поста сразу: лента сдвинется на целый ряд.'
      : shift === 0
        ? 'Новый пост сдвигает ленту на позицию, а паттерн остаётся тем же: публиковать можно по одному.'
        : `Новый пост сдвигает ленту на позицию — паттерн тот же, меняется только фаза (на ${shift} ${plural(shift, 'ряд', 'ряда', 'рядов')}): публиковать можно по одному.`;
  return (
    <div className="pattern-mode" data-testid="pattern-mode" data-mode={pattern.postingMode}>
      <strong>{POSTING_MODE_LABELS[pattern.postingMode]}</strong>
      <p className="muted">{explanation}</p>
    </div>
  );
}
