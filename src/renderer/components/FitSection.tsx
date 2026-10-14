// «Подогнать текущую сетку» во вкладке «Цель» (spec, «Модуль 4. Паттерны»; docs/decisions/0025-fit.md):
// - «Подгонка» — стоимость каждой позиции с фото в её цели, сумма сейчас → после, сколько фото переедет, фаза
//   паттерна и «Переставить» (fitTiles, одна запись истории). Считает fitGrid из core по свежим признакам;
// - «Поправки к цели» — выбросы с целью позиции и их поправки (findFix, ADR 0021) с «Применить», «Применить все»
//   (applyTileFixes, одна запись истории) и «Заменить — в подбор из библиотеки (этап 6)».
import type { CSSProperties, MouseEvent } from 'react';
import { targetFixes, type TileFix } from '@core/harmony/fixes';
import type { FitPosition, FitRole, GridFit } from '@core/pattern/fit';
import { PATTERN_COLUMNS } from '@core/pattern/pattern';
import type { Project } from '@core/project/types';
import { useGridAnalysis } from '../analysis';
import { applyTileFixes, clickTileInAnalysis, fitTiles } from '../commands';
import { useFixStore } from '../fixes';
import { unavailableSlots, useGridFit } from '../fit';
import { useMetricsStore } from '../metrics';
import { plural } from '../plural';
import { useAppStore } from '../store';
import { OutlierList } from './OutliersSection';

const ROLE_LABELS: Record<FitRole, string> = {
  movable: '',
  published: 'опубликован — на месте',
  locked: 'зафиксирован — на месте',
  empty: 'пустая позиция — вне подгонки',
  pinned: 'закреплён — вне ленты',
};

/** Стоимость — в долях допуска, как отклонение режима 7. */
const formatCost = (cost: number) => cost.toFixed(1);

export function FitSection({ project }: { project: Project }) {
  const result = useGridFit();
  const { done, total } = useMetricsStore((state) => state.progress);
  const assets = useAppStore((state) => state.snapshot?.assets);
  if (!project.pattern || !result || result.kind === 'none') {
    return (
      <p className="muted" data-testid="fit" data-state="none">
        Подгонка — по паттерну: сначала примените его к сетке.
      </p>
    );
  }
  if (result.kind === 'pending') {
    // Превью не построено (оригинал пропал): признаков этих плиток не будет, «Считаем…» висело бы вечно.
    const unavailable = unavailableSlots(project, assets, result.missing);
    if (unavailable.length > 0) {
      const positions = unavailable.map((id) => project.slots.findIndex((slot) => slot.id === id) + 1);
      const n = unavailable.length;
      return (
        <p className="muted" data-testid="fit" data-state="unavailable" data-missing={n}>
          Нет данных для {n} {plural(n, 'плитки', 'плиток', 'плиток')} (
          {plural(n, 'позиция', 'позиции', 'позиции')} {positions.join(', ')}): превью не построено — оригинал пропал или
          изменился. Подгонке нужны признаки всех фото ленты: верните {plural(n, 'оригинал', 'оригиналы', 'оригиналы')} на
          место и откройте проект заново.
        </p>
      );
    }
    return (
      <p className="muted" data-testid="fit" data-state="pending">
        Считаем признаки плиток…{done < total ? ` ${done} из ${total}` : ''}
      </p>
    );
  }
  return <FitReady fit={result} ratio={project.grid.ratio} />;
}

function FitReady({ fit, ratio }: { fit: GridFit; ratio: Project['grid']['ratio'] }) {
  const unchanged = fit.moved === 0 && fit.shift === 0;
  return (
    <div
      className="fit"
      data-testid="fit"
      data-state="ready"
      data-shift={fit.shift}
      data-before={fit.before}
      data-after={fit.after}
      data-moved={fit.moved}
      data-order={fit.order.join(' ')}
    >
      <p className="muted">
        Стоимость — насколько фото далеко от цели позиции, в допусках: 0 — в цели. Подгонка переставляет фото так, чтобы
        сумма была наименьшей.
      </p>
      <CostMap positions={fit.positions} ratio={ratio} />
      <dl className="analysis-stats">
        <dt>Сумма</dt>
        <dd data-testid="fit-sum">
          {formatCost(fit.before)} → {formatCost(fit.after)}
        </dd>
        <dt>Переедут</dt>
        <dd data-testid="fit-moved">
          {fit.moved === 0 ? 'никто' : `${fit.moved} фото`}
        </dd>
        <dt>Фаза</dt>
        <dd data-testid="fit-shift">{phaseText(fit.shift)}</dd>
      </dl>
      <p className="muted">Опубликованные, закреплённые и зафиксированные посты остаются на местах.</p>
      <div className="button-row">
        <button className="primary" disabled={unchanged} onClick={() => fitTiles(fit)}>
          Переставить
        </button>
        {unchanged && <span className="muted fit-note">Сетка уже подогнана</span>}
      </div>
    </div>
  );
}

/** «нынешняя», «сдвиг на 1 позицию: позиция 1 получает клетку 2 периода», «сдвиг на ряд». */
function phaseText(shift: number): string {
  if (shift === 0) return 'нынешняя';
  const rows = shift / PATTERN_COLUMNS;
  const by = Number.isInteger(rows)
    ? rows === 1
      ? 'на ряд'
      : `на ${rows} ${plural(rows, 'ряд', 'ряда', 'рядов')}`
    : `на ${shift} ${plural(shift, 'позицию', 'позиции', 'позиций')}`;
  return `сдвиг ${by}: позиция 1 получает клетку ${shift + 1} периода`;
}

/**
 * Карта стоимости 3 × N: в клетке — стоимость фото в цели его позиции сейчас и, если фото переедет, куда.
 * Клик выделяет плитку. Цвет нейтральный: цветной хром вокруг фото сбивает восприятие цвета.
 */
function CostMap({ positions, ratio }: { positions: readonly FitPosition[]; ratio: Project['grid']['ratio'] }) {
  const selection = useAppStore((state) => state.selection);
  const selected = new Set(selection.ids);
  const onClick = (event: MouseEvent, slotId: string) => {
    const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
    clickTileInAnalysis(slotId, mode);
  };
  const style = {
    gridTemplateColumns: `repeat(${PATTERN_COLUMNS}, 1fr)`,
    '--cell-aspect': ratio === '1:1' ? '1 / 1' : '3 / 4',
  } as CSSProperties;
  return (
    <div className="luma-map cost-map" data-testid="fit-map" style={style}>
      {positions.map((p) => {
        const moves = p.to !== p.index;
        const classes = ['luma-cell', 'cost-cell', p.role, moves ? 'moves' : '', selected.has(p.slotId) ? 'selected' : ''].filter(Boolean);
        const note = ROLE_LABELS[p.role];
        const title = `Пост ${p.index + 1}${p.cost === null ? '' : ` · стоимость ${p.cost.toFixed(2)}`}${moves ? ` · переедет на ${p.to + 1}` : ''}${note ? ` · ${note}` : ''}`;
        return (
          <button
            key={p.slotId}
            className={classes.join(' ')}
            data-testid="fit-cell"
            data-index={p.index}
            data-slot-id={p.slotId}
            data-role={p.role}
            data-cost={p.cost ?? undefined}
            data-to={p.to}
            aria-pressed={selected.has(p.slotId)}
            title={title}
            onClick={(event) => onClick(event, p.slotId)}
          >
            {p.cost === null ? (p.role === 'pinned' ? 'закр.' : '') : formatCost(p.cost)}
            {moves && <span className="cost-move">→ {p.to + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * «Поправки к цели»: выбросы с целью позиции и их поправки. «Применить все» — поправки всех таких плиток одной
 * записью истории: ожидание цели не зависит от соседей. Пока какая-то поправка считается, кнопка недоступна.
 */
export function TargetFixesSection({ project }: { project: Project }) {
  const analysis = useGridAnalysis(project);
  const entries = useFixStore((state) => state.bySlot);
  const outliers = analysis.outliers.filter((o) => o.source === 'target');
  if (outliers.length === 0) {
    const targeted = analysis.expectations.some((e) => e.source === 'target');
    return (
      <p className="muted" data-testid="target-fixes" data-state="none">
        {targeted ? 'Все плитки с целью в допуске.' : 'Плиток с целью пока нет.'}
      </p>
    );
  }
  const ready: Record<string, TileFix> = {};
  for (const outlier of outliers) {
    const entry = entries[outlier.slotId];
    if (entry?.state === 'ready') ready[outlier.slotId] = entry.fix;
  }
  const fixes = targetFixes(outliers, ready);
  const pending = outliers.some((o) => !o.published && entries[o.slotId]?.state !== 'ready' && entries[o.slotId]?.state !== 'error');
  return (
    <div className="target-fixes" data-testid="target-fixes" data-state="list" data-count={outliers.length}>
      <OutlierList outliers={outliers} replaceNote="в подбор из библиотеки (этап 6)" />
      <div className="button-row">
        <button
          data-testid="apply-all-fixes"
          data-count={fixes.length}
          disabled={pending || fixes.length === 0}
          title="Поправки всех плиток с целью — одной записью истории"
          onClick={() => applyTileFixes(fixes)}
        >
          Применить все{fixes.length > 0 ? ` (${fixes.length})` : ''}
        </button>
      </div>
    </div>
  );
}
