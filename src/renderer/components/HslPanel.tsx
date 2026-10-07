import { useState } from 'react';
import type { Rgb } from '@core/color/srgb';
import { hslTrack, type HslProperty } from '@core/color/swatches';
import { HUE_BANDS } from '@core/project/defaults';
import type { Adjust, HueBand } from '@core/project/types';
import { Slider } from './Slider';

const PROPERTIES: { id: HslProperty; label: string }[] = [
  { id: 'hue', label: 'Тон' },
  { id: 'sat', label: 'Насыщенность' },
  { id: 'lum', label: 'Яркость' },
];

export const BAND_LABELS: Readonly<Record<HueBand, string>> = {
  red: 'Красный',
  orange: 'Оранжевый',
  yellow: 'Жёлтый',
  green: 'Зелёный',
  aqua: 'Голубой',
  blue: 'Синий',
  purple: 'Фиолетовый',
  magenta: 'Пурпурный',
};

const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

/** Градиенты дорожек считает core: что ползунок делает с цветом своего диапазона. */
function tracks(property: HslProperty): Record<HueBand, string> {
  return Object.fromEntries(
    HUE_BANDS.map((band) => [band, `linear-gradient(to right, ${hslTrack(band, property).map(css).join(', ')})`]),
  ) as Record<HueBand, string>;
}

const TRACKS: Record<HslProperty, Record<HueBand, string>> = { hue: tracks('hue'), sat: tracks('sat'), lum: tracks('lum') };

/** HSL по 8 диапазонам: вкладки «Тон», «Насыщенность», «Яркость», как в Lightroom. */
export function HslPanel({
  hsl,
  disabled,
  gesture,
  onEdit,
}: {
  hsl: Adjust['hsl'];
  disabled: boolean;
  gesture: string;
  onEdit: (change: (adjust: Adjust) => void, gesture?: string) => void;
}) {
  const [property, setProperty] = useState<HslProperty>('hue');
  const gradients = TRACKS[property];

  return (
    <div className="hsl-panel" data-testid="hsl-panel">
      <div className="segmented" role="tablist" aria-label="Свойство HSL">
        {PROPERTIES.map(({ id, label }) => (
          <button key={id} role="tab" aria-selected={property === id} onClick={() => setProperty(id)}>
            {label}
          </button>
        ))}
      </div>
      {HUE_BANDS.map((band) => (
        <Slider
          key={band}
          label={BAND_LABELS[band]}
          value={hsl[band][property]}
          min={-100}
          max={100}
          step={1}
          disabled={disabled}
          testId={`value-hsl-${band}-${property}`}
          track={gradients[band]}
          onChange={(value) => onEdit((a) => void (a.hsl[band][property] = value), `${gesture}:hsl:${band}:${property}`)}
          onReset={() => onEdit((a) => void (a.hsl[band][property] = 0))}
        />
      ))}
    </div>
  );
}
