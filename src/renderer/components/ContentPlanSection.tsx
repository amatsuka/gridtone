// «План контента» во вкладке «Цель» (spec, «Модуль 4. Паттерны», «Режим «План контента»»;
// docs/decisions/0026-content-plan.md): карточка на каждую запланированную и пустую позицию в порядке публикации —
// номер, образец цели, подсказка из корзин, фото или «пусто». У паттерна «пачками» карточки ленты сгруппированы
// по три, закреплённые — отдельно, последними. Кандидатов из библиотеки до этапа 6 нет: место под них пустое.
// План считает core (contentPlan) — производные данные, в проект не пишутся; клик по карточке выделяет позицию.
import { useMemo, type MouseEvent } from 'react';
import { contentPlan, type ContentPlan, type PlanCard } from '@core/pattern/plan';
import { POSTING_MODE_LABELS } from '@core/pattern/pattern';
import type { Project } from '@core/project/types';
import { clickTileInAnalysis } from '../commands';
import { plural } from '../plural';
import { useAppStore } from '../store';
import { targetTitle } from './PatternPreview';

interface CardGroup {
  key: string;
  /** Заголовок группы; у плана без пачек — нет. */
  title: string | null;
  kind: 'batch' | 'pinned' | 'all';
  batch: number | null;
  cards: PlanCard[];
}

/** Пачки по три и закреплённые — у паттерна «пачками»; иначе одна группа, закреплённые в конце. */
function cardGroups(plan: ContentPlan): CardGroup[] {
  if (plan.pattern?.postingMode !== 'batch') return [{ key: 'all', title: null, kind: 'all', batch: null, cards: plan.cards }];
  const groups: CardGroup[] = [];
  for (const card of plan.cards) {
    const key = card.batch === null ? 'pinned' : `batch-${card.batch}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group =
        card.batch === null
          ? { key, title: 'Закрепить', kind: 'pinned', batch: null, cards: [] }
          : { key, title: `Пачка ${card.batch}`, kind: 'batch', batch: card.batch, cards: [] };
      groups.push(group);
    }
    group.cards.push(card);
  }
  return groups;
}

export function ContentPlanSection({ project }: { project: Project }) {
  const plan = useMemo(() => contentPlan(project), [project]);
  const selection = useAppStore((state) => state.selection);
  if (plan.cards.length === 0) {
    return (
      <p className="muted" data-testid="content-plan" data-state="none">
        В плане нет позиций: запланированных постов и пустых позиций нет. Места под будущие посты — «+ Ряд пустых» в тулбаре.
      </p>
    );
  }
  const selected = new Set(selection.ids);
  const onClick = (event: MouseEvent, slotId: string) => {
    const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
    clickTileInAnalysis(slotId, mode);
  };
  const count = plan.cards.length;
  return (
    <div
      className="content-plan"
      data-testid="content-plan"
      data-state="list"
      data-count={count}
      data-posting-mode={plan.pattern?.postingMode ?? ''}
    >
      <p className="muted">
        {count} {plural(count, 'позиция', 'позиции', 'позиций')} в порядке публикации, снизу вверх: 1-й — последняя позиция
        ленты.{plan.pattern ? ` ${POSTING_MODE_LABELS[plan.pattern.postingMode]}.` : ''}
      </p>
      {plan.warnings.map((warning) => (
        <p key={warning} className="plan-warning" data-testid="plan-warning">
          {warning}
        </p>
      ))}
      {cardGroups(plan).map((group) => (
        <section key={group.key} className="plan-group" data-testid="plan-group" data-kind={group.kind} data-batch={group.batch ?? undefined}>
          {group.title && <h4 data-testid="plan-group-title">{group.title}</h4>}
          {group.cards.map((card) => (
            <PlanCardView key={card.slotId} card={card} selected={selected.has(card.slotId)} onClick={onClick} />
          ))}
        </section>
      ))}
    </div>
  );
}

function PlanCardView({
  card,
  selected,
  onClick,
}: {
  card: PlanCard;
  selected: boolean;
  onClick: (event: MouseEvent, slotId: string) => void;
}) {
  const { target, rgb } = card;
  const classes = ['plan-card', selected ? 'selected' : '', card.pin ? 'pin' : '', card.photo === null ? 'empty' : ''].filter(Boolean);
  return (
    <button
      className={classes.join(' ')}
      data-testid="plan-card"
      data-number={card.number}
      data-index={card.index}
      data-slot-id={card.slotId}
      data-batch={card.batch ?? undefined}
      data-pin={card.pin}
      data-photo={card.photo !== null}
      data-below={card.belowPublished}
      data-hint={card.hint}
      data-l={target?.L}
      data-hue={target?.hue}
      data-chroma={target?.chroma}
      aria-pressed={selected}
      title={`Позиция ${card.index + 1}${target ? ` · цель ${targetTitle(target)}` : ''}`}
      onClick={(event) => onClick(event, card.slotId)}
    >
      <span
        className={rgb ? 'plan-swatch' : 'plan-swatch none'}
        data-testid="plan-swatch"
        style={rgb ? { backgroundColor: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` } : undefined}
      />
      <span className="plan-body">
        <span className={card.belowPublished ? 'plan-number warn' : 'plan-number'} data-testid="plan-number">
          {card.number}-й{card.pin ? ' · закрепить' : ''}
          <span className="muted"> · позиция {card.index + 1}</span>
        </span>
        <span className="plan-hint" data-testid="plan-hint">
          {card.hint}
        </span>
        <span className="muted plan-photo">{card.photo ?? 'пусто — сюда нужен пост'}</span>
        {card.belowPublished && <span className="plan-note warn">ниже опубликованного: на этом месте не опубликовать</span>}
      </span>
      <span className="plan-candidates">кандидаты появятся с библиотекой</span>
    </button>
  );
}
