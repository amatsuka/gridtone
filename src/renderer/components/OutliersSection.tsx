// Раздел «Выбросы» вкладки «Анализ» (spec, «Выбросы и исправления»; docs/decisions/0020-outliers.md): строка
// на плитку, которая по яркости, температуре, хроме или тону дальше допуска от цели или от сетки. В строке —
// номер, причины «было → ожидается» от худшей, пометки «по цели» и «опубликован». Считает core
// (`analyzeGrid` → `tileExpectations`); поправки и «Применить» — подэтап 4г.
import type { MouseEvent } from 'react';
import { formatPart, type TileExpectation } from '@core/harmony/outliers';
import type { GridAnalysis } from '@core/metrics/grid';
import { clickTileInAnalysis } from '../commands';
import { plural } from '../plural';
import { useAppStore } from '../store';

export function OutliersSection({ analysis }: { analysis: GridAnalysis }) {
  const selection = useAppStore((state) => state.selection);
  const selected = new Set(selection.ids);
  const { outliers } = analysis;
  const onClick = (event: MouseEvent, outlier: TileExpectation) => {
    const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
    clickTileInAnalysis(outlier.slotId, mode);
  };

  if (outliers.length === 0) {
    return (
      <p className="muted" data-testid="outliers-none">
        Все плитки в допуске.
      </p>
    );
  }
  return (
    <>
      <p className="muted" data-testid="outliers-count" data-count={outliers.length}>
        {outliers.length} {plural(outliers.length, 'плитка выбивается', 'плитки выбиваются', 'плиток выбиваются')}
      </p>
      <ul className="outliers" data-testid="outliers">
        {outliers.map((outlier) => (
          <li key={outlier.slotId}>
            <button
              className={`outlier${selected.has(outlier.slotId) ? ' selected' : ''}`}
              data-testid="outlier"
              data-slot-id={outlier.slotId}
              data-index={outlier.index}
              data-deviation={outlier.deviation}
              data-source={outlier.source}
              data-published={outlier.published}
              aria-pressed={selected.has(outlier.slotId)}
              title={`Отклонение ${outlier.deviation.toFixed(1)} допуска · ожидание ${outlier.source === 'target' ? 'по цели позиции' : 'по сетке'}`}
              onClick={(event) => onClick(event, outlier)}
            >
              <span className="outlier-number">{outlier.index + 1}</span>
              <span className="outlier-reasons">
                {outlier.reasons.map((part) => (
                  <span
                    key={part.reason}
                    className="outlier-reason"
                    data-testid="outlier-reason"
                    data-reason={part.reason}
                    data-value={part.value}
                    data-expected={part.expected}
                    data-ratio={part.ratio}
                  >
                    {formatPart(part)}
                  </span>
                ))}
                {(outlier.source === 'target' || outlier.published) && (
                  <span className="outlier-marks muted">
                    {[outlier.source === 'target' ? 'по цели' : '', outlier.published ? 'опубликован' : ''].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
