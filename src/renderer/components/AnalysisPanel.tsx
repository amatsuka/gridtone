// Вкладка «Анализ» инспектора (spec, модуль 3; docs/decisions/0018-features-grid-metrics.md): карта яркости,
// ритм, разброс, контраст соседей и палитра сетки. Признаки плиток считает воркер метрик, анализ сетки по ним —
// analyzeGrid из core прямо здесь: на 90 плитках это миллисекунды. В проект ничего не пишется.
import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { analyzeGrid, type GridAnalysis, type GridMetrics, type LumaCell } from '@core/metrics/grid';
import type { PaletteEntry } from '@core/metrics/palette';
import { FLAT_SPREAD, MIN_GRID_TILES, RHYTHM_LABELS, type Rhythm, type TemplateFit } from '@core/metrics/rhythm';
import { labToSrgb8 } from '@core/metrics/tile';
import type { Project } from '@core/project/types';
import { clickTileInAnalysis } from '../commands';
import { useMetricsStore } from '../metrics';
import { useAppStore } from '../store';

const cssRgb = ([r, g, b]: readonly [number, number, number]) => `rgb(${r} ${g} ${b})`;
const fixed = (value: number, digits = 2) => value.toFixed(digits);

export function AnalysisPanel({ project }: { project: Project }) {
  const bySlot = useMetricsStore((state) => state.bySlot);
  const { done, total } = useMetricsStore((state) => state.progress);
  const analysis = useMemo(() => analyzeGrid(project, bySlot), [project, bySlot]);

  return (
    <div className="analysis" data-testid="analysis-panel" data-photos={analysis.photos} data-measured={analysis.measured}>
      <header className="inspector-header">
        <h2>Анализ сетки</h2>
      </header>
      {done < total && (
        <p className="muted" data-testid="analysis-progress" data-done={done} data-total={total}>
          Посчитано {done} из {total}
        </p>
      )}
      {project.slots.length === 0 ? (
        <p className="muted">В проекте пока нет фото.</p>
      ) : (
        <>
          <h3>Яркость</h3>
          <LumaMap analysis={analysis} ratio={project.grid.ratio} />
          {analysis.metrics ? (
            <LumaStats metrics={analysis.metrics} />
          ) : analysis.photos < MIN_GRID_TILES ? (
            <p className="muted" data-testid="analysis-too-few">
              Нужно хотя бы {MIN_GRID_TILES} плиток с фото: на одном ряду ритм и разброс ничего не значат.
            </p>
          ) : (
            <p className="muted">Считаем признаки плиток…</p>
          )}
          {analysis.metrics && (
            <>
              <h3>Палитра сетки</h3>
              <PaletteBar palette={analysis.metrics.palette} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Мини-карта 3 × N: клетка залита серым своей L. Клик выделяет плитку, ⌘ и Shift — как в сетке. */
function LumaMap({ analysis, ratio }: { analysis: GridAnalysis; ratio: Project['grid']['ratio'] }) {
  const selection = useAppStore((state) => state.selection);
  const selected = new Set(selection.ids);
  const onClick = (event: MouseEvent, cell: LumaCell) => {
    const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
    clickTileInAnalysis(cell.slotId, mode);
  };

  const mapStyle = {
    gridTemplateColumns: `repeat(${analysis.columns}, 1fr)`,
    '--cell-aspect': ratio === '1:1' ? '1 / 1' : '3 / 4',
  } as CSSProperties;

  return (
    <div className="luma-map" data-testid="luma-map" style={mapStyle}>
      {analysis.cells.map((cell) => {
        if (!cell.photo) return <div key={cell.slotId} className="luma-cell empty" data-testid="luma-cell" data-index={cell.index} />;
        const L = cell.L;
        // Подпись тёмная на светлой клетке и светлая на тёмной.
        const style = L === null ? undefined : { backgroundColor: cssRgb(labToSrgb8([L, 0, 0])), color: L > 0.62 ? '#111' : '#eee' };
        const classes = ['luma-cell', selected.has(cell.slotId) ? 'selected' : '', cell.published ? 'published' : ''].filter(Boolean);
        return (
          <button
            key={cell.slotId}
            className={classes.join(' ')}
            style={style}
            data-testid="luma-cell"
            data-index={cell.index}
            data-slot-id={cell.slotId}
            data-l={L ?? undefined}
            aria-pressed={selected.has(cell.slotId)}
            title={`Пост ${cell.index + 1}${cell.published ? ', опубликован' : ''}${L === null ? '' : ` · L ${fixed(L, 3)}`}`}
            onClick={(event) => onClick(event, cell)}
          >
            {L === null ? '…' : fixed(L)}
          </button>
        );
      })}
    </div>
  );
}

function rhythmText(rhythm: Rhythm): string {
  if (rhythm.kind === 'flat') return 'Ровная';
  if (rhythm.kind === 'none') return 'Не распознан';
  return fitLabel(rhythm.best);
}

function fitLabel(fit: TemplateFit): string {
  if (fit.template !== 'gradient' || fit.slope === undefined) return RHYTHM_LABELS[fit.template];
  return `${RHYTHM_LABELS.gradient}, новые ${fit.slope >= 0 ? 'светлее' : 'темнее'}`;
}

function LumaStats({ metrics }: { metrics: GridMetrics }) {
  const { rhythm, spread, contrast } = metrics;
  const best = rhythm.kind === 'flat' ? undefined : rhythm.best;
  const format = (value: number | null) => (value === null ? '—' : fixed(value, 3));
  return (
    <>
      <dl className="analysis-stats">
        <dt>Ритм</dt>
        <dd
          data-testid="rhythm"
          data-kind={rhythm.kind}
          data-template={best?.template}
          data-strength={best?.strength}
          data-slope={best?.slope}
        >
          {rhythmText(rhythm)}
          {rhythm.kind === 'pattern' && <span className="muted"> · сила {fixed(rhythm.best.strength)}</span>}
          {rhythm.kind === 'none' && (
            <span className="muted">
              {' '}
              · ближе всего {fitLabel(rhythm.best).toLowerCase()}, {fixed(rhythm.best.strength)}
            </span>
          )}
          {rhythm.kind === 'flat' && <span className="muted"> · разброс L меньше {FLAT_SPREAD}</span>}
        </dd>
        <dt>Разброс L</dt>
        <dd data-testid="luma-spread" data-value={spread}>
          {fixed(spread, 3)}
        </dd>
        <dt>Контраст соседей</dt>
        <dd
          data-testid="neighbor-contrast"
          data-horizontal={contrast.horizontal ?? undefined}
          data-vertical={contrast.vertical ?? undefined}
        >
          ↔ {format(contrast.horizontal)} · ↕ {format(contrast.vertical)}
        </dd>
      </dl>
      <details className="rhythm-fits">
        <summary className="muted">Сила всех шаблонов</summary>
        <ul>
          {rhythm.fits.map((fit) => (
            <li key={fit.template} data-testid="rhythm-fit" data-template={fit.template} data-strength={fit.strength}>
              <span>{fitLabel(fit)}</span>
              <span className="muted">{fixed(fit.strength)}</span>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** Полоса палитры сетки: ширина цвета — его доля. */
function PaletteBar({ palette }: { palette: readonly PaletteEntry[] }) {
  return (
    <div className="palette-bar" data-testid="grid-palette">
      {palette.map(({ lab, share }, i) => (
        <span
          key={i}
          className="palette-swatch"
          data-testid="grid-palette-entry"
          data-lab={lab.join(' ')}
          data-share={share}
          style={{ flexGrow: share, backgroundColor: cssRgb(labToSrgb8(lab)) }}
          title={`${Math.round(share * 100)}% · L ${fixed(lab[0])}`}
        />
      ))}
    </div>
  );
}
