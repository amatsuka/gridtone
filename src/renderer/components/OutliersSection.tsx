// Раздел «Выбросы» вкладки «Анализ» (spec, «Выбросы и исправления»; docs/decisions/0020-outliers.md, 0021-fixes.md):
// строка на плитку, которая по яркости, температуре, хроме или тону дальше допуска от цели или от сетки. В строке —
// номер, причины «было → ожидается» от худшей, пометки «по цели» и «опубликован», под ними — поправка худшей
// причины с «Применить», «заменить» с лучшим в лимите или «опубликован, не правится». Выбросы считает core
// (`analyzeGrid` → `tileExpectations`), поправки — findFix в воркере (fixes.ts).
import type { MouseEvent } from 'react';
import { formatFix, formatSliderValue } from '@core/harmony/fixes';
import { formatPart, formatReasonValue, REASON_LABELS, type TileExpectation } from '@core/harmony/outliers';
import type { GridAnalysis } from '@core/metrics/grid';
import { applyTileFix, clickTileInAnalysis } from '../commands';
import { useFixStore, type FixEntry } from '../fixes';
import { plural } from '../plural';
import { useAppStore } from '../store';

export function OutliersSection({ analysis }: { analysis: GridAnalysis }) {
  const selection = useAppStore((state) => state.selection);
  const fixes = useFixStore((state) => state.bySlot);
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
          <li key={outlier.slotId} className="outlier-row">
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
            <FixLine outlier={outlier} entry={fixes[outlier.slotId]} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Строка поправки под выбросом: поправка и «Применить», «заменить» или «опубликован, не правится». */
function FixLine({ outlier, entry }: { outlier: TileExpectation; entry: FixEntry | undefined }) {
  if (outlier.published) {
    return (
      <p className="outlier-fix muted" data-testid="outlier-fix" data-state="published">
        опубликован, не правится
      </p>
    );
  }
  if (!entry || entry.state === 'pending') {
    return (
      <p className="outlier-fix muted" data-testid="outlier-fix" data-state="pending">
        Считаем поправку…
      </p>
    );
  }
  if (entry.state === 'error') {
    return (
      <p className="outlier-fix muted" data-testid="outlier-fix" data-state="error">
        Поправку посчитать не удалось
      </p>
    );
  }
  const { fix } = entry;
  const reached = `${REASON_LABELS[fix.reason]} ${formatReasonValue(fix.reason, fix.reached)}`;
  const title = `${fix.bands ? 'Тон диапазонов' : 'Ползунок'} ${formatSliderValue(fix.slider, fix.from)} → ${formatSliderValue(fix.slider, fix.value)}, ${reached}`;
  return (
    <p
      className={`outlier-fix${fix.replace ? ' replace' : ''}`}
      data-testid="outlier-fix"
      data-state={fix.replace ? 'replace' : 'fix'}
      data-slider={fix.slider}
      data-from={fix.from}
      data-value={fix.value}
      data-reached={fix.reached}
      data-target={fix.target}
      data-exact={fix.exact}
      data-bands={fix.bands?.join(' ')}
      title={title}
    >
      {fix.replace ? (
        <>
          <span className="outlier-replace">Заменить</span>
          <span className="muted">
            {' '}
            · в пределах лимита — {reached}
          </span>
        </>
      ) : (
        <>
          <span>{formatFix(fix)}</span>
          {!fix.exact && <span className="muted"> · до лимита</span>}
          <button className="apply-fix" data-testid="apply-fix" onClick={() => applyTileFix(outlier.slotId, fix)}>
            Применить
          </button>
        </>
      )}
    </p>
  );
}
