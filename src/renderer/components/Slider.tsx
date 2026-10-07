import type { CSSProperties } from 'react';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  /** data-testid подписи со значением. */
  testId: string;
  /** Знаков после запятой в подписи. */
  digits?: number;
  /** Фон дорожки, например градиент цветов HSL. */
  track?: string;
  onChange: (value: number) => void;
  onReset: () => void;
}

/** «+1.00», «−30», «0»: минус типографский, как в Lightroom. */
export function formatSigned(value: number, digits = 0): string {
  const text = digits > 0 ? Math.abs(value).toFixed(digits) : String(Math.round(Math.abs(value)));
  return value > 0 ? `+${text}` : value < 0 && Number(text) !== 0 ? `−${text}` : text;
}

/** Ползунок коррекции. Двойной щелчок сбрасывает его в ноль, как в Lightroom. */
export function Slider({ label, value, min, max, step, disabled, testId, digits = 0, track, onChange, onReset }: SliderProps) {
  const style = track ? ({ '--track': track } as CSSProperties) : undefined;
  return (
    <label className="slider" onDoubleClick={() => !disabled && onReset()}>
      <span className="slider-label">{label}</span>
      <output className="slider-value" data-testid={testId}>
        {formatSigned(value, digits)}
      </output>
      <input
        type="range"
        className={track ? 'tracked' : undefined}
        style={style}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}
