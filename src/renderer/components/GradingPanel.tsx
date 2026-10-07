import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { wheelFromPoint, wheelImage, wheelToPoint } from '@core/color/swatches';
import type { Adjust, Wheel } from '@core/project/types';
import { Slider } from './Slider';

type WheelKey = 'shadows' | 'midtones' | 'highlights';

const WHEELS: { key: WheelKey; label: string }[] = [
  { key: 'shadows', label: 'Тени' },
  { key: 'midtones', label: 'Средние' },
  { key: 'highlights', label: 'Света' },
];

const NEUTRAL: Wheel = { hue: 0, amount: 0 };

/** Картинку круга считает core, одну на все круги. */
const IMAGE_SIZE = 160;
let wheelPixels: ImageData | null = null;

/** Цветокоррекция по трём кругам и баланс (spec, «Коррекция в два уровня»). */
export function GradingPanel({
  grading,
  disabled,
  gesture,
  onEdit,
}: {
  grading: Adjust['grading'];
  disabled: boolean;
  gesture: string;
  onEdit: (change: (adjust: Adjust) => void, gesture?: string) => void;
}) {
  const setWheel = (key: WheelKey, wheel: Wheel, gestureKey?: string) =>
    onEdit((a) => {
      const current = a.grading[key];
      // Тот же тон и сила — не правка: иначе каждое движение мыши писало бы пустую запись.
      if (current.hue !== wheel.hue || current.amount !== wheel.amount) a.grading[key] = { ...wheel };
    }, gestureKey);

  return (
    <div className="grading-panel">
      <div className="wheels">
        {WHEELS.map(({ key, label }) => (
          <ColorWheel
            key={key}
            id={key}
            label={label}
            wheel={grading[key]}
            disabled={disabled}
            onChange={(wheel) => setWheel(key, wheel, `${gesture}:wheel:${key}`)}
            onReset={() => setWheel(key, NEUTRAL)}
          />
        ))}
      </div>
      <Slider
        label="Баланс"
        value={grading.balance}
        min={-100}
        max={100}
        step={1}
        disabled={disabled}
        testId="value-balance"
        onChange={(value) => onEdit((a) => void (a.grading.balance = value), `${gesture}:balance`)}
        onReset={() => onEdit((a) => void (a.grading.balance = 0))}
      />
    </div>
  );
}

/**
 * Круг: тон — угол (0° вправо, против часовой), сила — расстояние от центра. Перетаскивание двигает
 * точку, с Shift меняется только сила, двойной щелчок сбрасывает. Геометрия — core/color/swatches.ts.
 */
function ColorWheel({
  id,
  label,
  wheel,
  disabled,
  onChange,
  onReset,
}: {
  id: WheelKey;
  label: string;
  wheel: Wheel;
  disabled: boolean;
  onChange: (wheel: Wheel) => void;
  onReset: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<number | null>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    wheelPixels ??= new ImageData(wheelImage(IMAGE_SIZE), IMAGE_SIZE, IMAGE_SIZE);
    context.putImageData(wheelPixels, 0, 0);
  }, []);

  const pick = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const r = rect.width / 2;
    const next = wheelFromPoint((event.clientX - rect.left - r) / r, (event.clientY - rect.top - r) / r);
    onChange(event.shiftKey && wheel.amount > 0 ? { hue: wheel.hue, amount: next.amount } : next);
  };

  const [x, y] = wheelToPoint(wheel.hue, wheel.amount);
  return (
    <div className="wheel-cell">
      <div
        className={`wheel${disabled ? ' disabled' : ''}`}
        data-testid={`wheel-${id}`}
        aria-label={`Круг: ${label.toLowerCase()}`}
        role="group"
        onPointerDown={(event) => {
          // Второй щелчок двойного — только сброс в onDoubleClick.
          if (disabled || event.button !== 0 || event.detail >= 2) return;
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (pointer.current === event.pointerId) pick(event);
        }}
        onPointerUp={() => (pointer.current = null)}
        onPointerCancel={() => (pointer.current = null)}
        onDoubleClick={() => !disabled && onReset()}
      >
        <canvas ref={canvasRef} width={IMAGE_SIZE} height={IMAGE_SIZE} />
        <span className="wheel-dot" style={{ left: `${50 + x * 50}%`, top: `${50 + y * 50}%` }} />
      </div>
      <span className="wheel-label">{label}</span>
      <output className="wheel-value" data-testid={`value-wheel-${id}`}>
        {wheel.amount === 0 ? '0' : `${Math.round(wheel.hue)}° · ${Math.round(wheel.amount)}`}
      </output>
    </div>
  );
}
