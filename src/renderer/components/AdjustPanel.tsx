import type { Adjust } from '@core/project/types';

type SliderKey = 'exposure' | 'temp' | 'tint' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'vibrance' | 'saturation';

interface SliderSpec {
  key: SliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

const percent = (key: SliderKey, label: string): SliderSpec => ({ key, label, min: -100, max: 100, step: 1 });

// Порядок как в Lightroom: баланс белого, тон, присутствие. Группы те же, что при копировании правок.
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
  { title: 'Присутствие', sliders: [percent('vibrance', 'Сочность'), percent('saturation', 'Насыщенность')] },
];

/**
 * Ползунки коррекции — общие для поправки фото и образа, на этапе 2в и для редактора фото.
 * gesture — префикс ключа жеста: движение одного ползунка склеивается в одну запись истории.
 */
export function AdjustPanel({
  adjust,
  disabled,
  gesture,
  onEdit,
}: {
  adjust: Adjust;
  disabled: boolean;
  gesture: string;
  onEdit: (change: (adjust: Adjust) => void, gesture?: string) => void;
}) {
  return (
    <>
      {GROUPS.map((group) => (
        <section key={group.title} className="inspector-group">
          <h3>{group.title}</h3>
          {group.sliders.map((spec) => (
            <Slider
              key={spec.key}
              spec={spec}
              value={adjust[spec.key]}
              disabled={disabled}
              onChange={(value) => onEdit((a) => void (a[spec.key] = value), `${gesture}:${spec.key}`)}
              // Сброс — отдельное действие, а не продолжение движения.
              onReset={() => onEdit((a) => void (a[spec.key] = 0))}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function format(spec: SliderSpec, value: number): string {
  const text = spec.key === 'exposure' ? value.toFixed(2) : String(Math.round(value));
  return value > 0 ? `+${text}` : value < 0 ? `−${text.slice(1)}` : text;
}

function Slider({
  spec,
  value,
  disabled,
  onChange,
  onReset,
}: {
  spec: SliderSpec;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    // Двойной щелчок сбрасывает ползунок в ноль, как в Lightroom.
    <label className="slider" onDoubleClick={() => !disabled && onReset()}>
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
