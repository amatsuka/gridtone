import type { Adjust } from '@core/project/types';
import { CurveEditor } from './CurveEditor';
import { GradingPanel } from './GradingPanel';
import { HslPanel } from './HslPanel';
import { Slider } from './Slider';

type SliderKey = 'exposure' | 'temp' | 'tint' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'vibrance' | 'saturation';

interface SliderSpec {
  key: SliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  digits?: number;
}

const percent = (key: SliderKey, label: string): SliderSpec => ({ key, label, min: -100, max: 100, step: 1 });

// Порядок как в Lightroom: баланс белого, тон, присутствие. Группы те же, что при копировании правок.
const GROUPS: { title: string; sliders: SliderSpec[] }[] = [
  { title: 'Баланс белого', sliders: [percent('temp', 'Температура'), percent('tint', 'Оттенок')] },
  {
    title: 'Тон',
    sliders: [
      { key: 'exposure', label: 'Экспозиция', min: -3, max: 3, step: 0.05, digits: 2 },
      percent('contrast', 'Контраст'),
      percent('highlights', 'Света'),
      percent('shadows', 'Тени'),
      percent('whites', 'Белые'),
      percent('blacks', 'Чёрные'),
    ],
  },
  { title: 'Присутствие', sliders: [percent('vibrance', 'Сочность'), percent('saturation', 'Насыщенность')] },
];

type EditHandler = (change: (adjust: Adjust) => void, gesture?: string) => void;

/**
 * Инструменты коррекции — общие для поправки фото и образа, на этапе 2в и для редактора фото:
 * ползунки, HSL, круги и кривые. Разделы идут в порядке групп копирования правок (adjustGroups.ts).
 * gesture — префикс ключа жеста: движение одного ползунка, круга или точки кривой — одна запись истории.
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
  onEdit: EditHandler;
}) {
  return (
    <>
      {GROUPS.map((group) => (
        <section key={group.title} className="inspector-group">
          <h3>{group.title}</h3>
          {group.sliders.map((spec) => (
            <Slider
              key={spec.key}
              label={spec.label}
              value={adjust[spec.key]}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              digits={spec.digits ?? 0}
              disabled={disabled}
              testId={`value-${spec.key}`}
              onChange={(value) => onEdit((a) => void (a[spec.key] = value), `${gesture}:${spec.key}`)}
              // Сброс — отдельное действие, а не продолжение движения.
              onReset={() => onEdit((a) => void (a[spec.key] = 0))}
            />
          ))}
        </section>
      ))}
      <section className="inspector-group">
        <h3>HSL</h3>
        <HslPanel hsl={adjust.hsl} disabled={disabled} gesture={gesture} onEdit={onEdit} />
      </section>
      <section className="inspector-group">
        <h3>Цветокоррекция</h3>
        <GradingPanel grading={adjust.grading} disabled={disabled} gesture={gesture} onEdit={onEdit} />
      </section>
      <section className="inspector-group">
        <h3>Кривые</h3>
        <CurveEditor curves={adjust.curves} disabled={disabled} gesture={gesture} onEdit={onEdit} />
      </section>
    </>
  );
}
