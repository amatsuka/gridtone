import { createAdjust } from '@core/project/defaults';
import type { Adjust, Slot } from '@core/project/types';
import { editProject, useAppStore } from '../store';

type SliderKey = 'exposure' | 'temp' | 'tint' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'vibrance' | 'saturation';

interface SliderSpec {
  key: SliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

const percent = (key: SliderKey, label: string): SliderSpec => ({ key, label, min: -100, max: 100, step: 1 });

// Порядок как в Lightroom: баланс белого, тон, присутствие.
const GROUPS: { title: string; sliders: SliderSpec[] }[] = [
  { title: 'Баланс белого', sliders: [percent('temp', 'Температура'), percent('tint', 'Оттенок')] },
  {
    title: 'Тон',
    sliders: [
      { key: 'exposure', label: 'Экспозиция', min: -3, max: 3, step: 0.05 },
      percent('contrast', 'Контраст'),
      percent('highlights', 'Света'),
      percent('shadows', 'Тени'),
      percent('whites', 'Белые'),
      percent('blacks', 'Чёрные'),
    ],
  },
  { title: 'Цвет', sliders: [percent('vibrance', 'Сочность'), percent('saturation', 'Насыщенность')] },
];

/** Правка поправки фото у слота: ищем по id, а не по индексу — порядок мог поменяться. */
function editAdjust(slotId: string, change: (adjust: Adjust) => void): void {
  editProject((project) => {
    const slot = project.slots.find((s) => s.id === slotId);
    if (slot) change(slot.adjust);
  });
}

function format(spec: SliderSpec, value: number): string {
  const text = spec.key === 'exposure' ? value.toFixed(2) : String(Math.round(value));
  return value > 0 ? `+${text}` : value < 0 ? `−${text.slice(1)}` : text;
}

export function Inspector() {
  const slot = useAppStore((state) => state.snapshot?.project.slots.find((s) => s.id === state.selectedSlotId));

  return (
    <aside className="inspector" data-testid="inspector">
      {slot ? <SlotAdjust slot={slot} /> : <p className="muted">Выберите плитку, чтобы править её цвет.</p>}
    </aside>
  );
}

function SlotAdjust({ slot }: { slot: Slot }) {
  // Опубликованные посты только участвуют в анализе (spec, «Статусы позиций»).
  const locked = slot.state === 'published' || !slot.assetId;
  const { adjust } = slot;

  return (
    <>
      <header className="inspector-header">
        <h2>Поправка фото</h2>
        <button className="link" disabled={locked} onClick={() => editAdjust(slot.id, (a) => Object.assign(a, createAdjust()))}>
          Сбросить
        </button>
      </header>
      {locked && <p className="muted">{slot.assetId ? 'Опубликованный пост не редактируется.' : 'В позиции нет фото.'}</p>}
      {GROUPS.map((group) => (
        <section key={group.title} className="inspector-group">
          <h3>{group.title}</h3>
          {group.sliders.map((spec) => (
            <Slider
              key={spec.key}
              spec={spec}
              value={adjust[spec.key]}
              disabled={locked}
              onChange={(value) => editAdjust(slot.id, (a) => void (a[spec.key] = value))}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function Slider({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: SliderSpec;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    // Двойной щелчок сбрасывает ползунок в ноль, как в Lightroom.
    <label className="slider" onDoubleClick={() => !disabled && onChange(0)}>
      <span className="slider-label">{spec.label}</span>
      <output className="slider-value" data-testid={`value-${spec.key}`}>
        {format(spec, value)}
      </output>
      <input
        type="range"
        aria-label={spec.label}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}
