// Раздел «Цвет» вкладки «Анализ» (spec, «Гармония»; docs/decisions/0019-harmony.md): колесо тонов с точками
// плиток и секторами лучшего шаблона Мацуды, тип гармонии и оценка. Всё считает core (`analyzeGrid` →
// `fitHarmony`); здесь только рисунок. Угол — как у кругов цветокоррекции 2б (0° вправо, против часовой),
// радиус — хрома среднего цвета плитки в масштабе картинки круга: точка лежит на своей хроме.
import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { WHEEL_PREVIEW_CHROMA, wheelImage, wheelToPoint } from '@core/color/swatches';
import { HARMONY_LABELS, type Harmony, type HarmonyFit, type Sector, type TileHue } from '@core/harmony/templates';
import type { GridMetrics, WheelPoint } from '@core/metrics/grid';
import { labToSrgb8, type TileMetrics } from '@core/metrics/tile';
import { clickTileInAnalysis } from '../commands';
import { plural } from '../plural';
import { useAppStore } from '../store';

/** Картинка круга, одна на все колёса анализа. */
const IMAGE_SIZE = 200;
let wheelPixels: ImageData | null = null;

const cssRgb = ([r, g, b]: readonly [number, number, number]) => `rgb(${r} ${g} ${b})`;

/** Точка колеса: доли радиуса, x вправо, y вниз. За краем круга — на краю. */
function wheelPosition(hue: number, chroma: number): [number, number] {
  return wheelToPoint(hue, Math.min(1, chroma / WHEEL_PREVIEW_CHROMA) * 100);
}

/** Клин сектора от центра круга радиуса 1: от края center − width/2 против часовой до center + width/2. */
function sectorPath({ center, width }: Sector): string {
  const [x0, y0] = wheelToPoint(center - width / 2, 100);
  const [x1, y1] = wheelToPoint(center + width / 2, 100);
  // В SVG y вниз: против часовой на экране — sweep-flag 0.
  return `M 0 0 L ${x0} ${y0} A 1 1 0 ${width > 180 ? 1 : 0} 0 ${x1} ${y1} Z`;
}

export function HarmonySection({ metrics, bySlot }: { metrics: GridMetrics; bySlot: Readonly<Record<string, TileMetrics>> }) {
  const { harmony, wheel } = metrics;
  const best = harmony.kind === 'template' ? harmony.best : undefined;
  const tiles = harmony.kind === 'template' ? harmony.tiles : undefined;
  const outside = tiles?.filter((tile) => tile.outside).length ?? 0;

  return (
    <>
      <HarmonyWheel wheel={wheel} tiles={tiles} best={best} bySlot={bySlot} />
      <dl className="analysis-stats">
        <dt>Гармония</dt>
        <dd
          data-testid="harmony"
          data-kind={harmony.kind}
          data-template={best?.template}
          data-angle={best?.angle}
          data-mirrored={best?.mirrored}
          data-score={best?.score}
          data-mean-weight={harmony.meanWeight}
        >
          {best ? (
            <>
              {best.template} — {HARMONY_LABELS[best.template].toLowerCase()}
              <span className="muted"> · {Math.round(best.angle)}°</span>
            </>
          ) : (
            <>
              Нейтральная сетка<span className="muted"> · плитки почти без цвета, тон не оценивается</span>
            </>
          )}
        </dd>
        {best && (
          <>
            <dt>Оценка</dt>
            <dd data-testid="harmony-score" data-value={best.score}>
              {best.score < 0.05 ? 'все тона в секторах' : `в среднем ${best.score.toFixed(1)}° за секторами`}
            </dd>
            <dt>Вне шаблона</dt>
            <dd data-testid="harmony-outside" data-count={outside}>
              {outside === 0 ? 'нет' : `${outside} ${plural(outside, 'плитка', 'плитки', 'плиток')}`}
            </dd>
          </>
        )}
      </dl>
      {harmony.kind === 'template' && <HarmonyFits harmony={harmony} />}
    </>
  );
}

/** Колесо: картинка круга, вне секторов — затемнение, контуры секторов, точки плиток. */
function HarmonyWheel({
  wheel,
  tiles,
  best,
  bySlot,
}: {
  wheel: readonly WheelPoint[];
  tiles: readonly TileHue[] | undefined;
  best: HarmonyFit | undefined;
  bySlot: Readonly<Record<string, TileMetrics>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskId = `harmony-mask-${useId().replace(/:/g, '')}`;
  const selection = useAppStore((state) => state.selection);
  const selected = new Set(selection.ids);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    wheelPixels ??= new ImageData(wheelImage(IMAGE_SIZE), IMAGE_SIZE, IMAGE_SIZE);
    context.putImageData(wheelPixels, 0, 0);
  }, []);

  const onClick = (event: MouseEvent, slotId: string) => {
    const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
    clickTileInAnalysis(slotId, mode);
  };

  return (
    <div className="harmony-wheel" data-testid="harmony-wheel">
      <canvas ref={canvasRef} width={IMAGE_SIZE} height={IMAGE_SIZE} />
      <svg viewBox="-1 -1 2 2" aria-hidden="true">
        {best && (
          <>
            <mask id={maskId}>
              <circle r="1" fill="#fff" />
              {best.sectors.map((sector, i) => (
                <path key={i} d={sectorPath(sector)} fill="#000" />
              ))}
            </mask>
            <circle r="1" className="harmony-shade" mask={`url(#${maskId})`} />
            {best.sectors.map((sector, i) => (
              <path
                key={i}
                className="harmony-sector"
                data-testid="harmony-sector"
                data-center={sector.center}
                data-width={sector.width}
                d={sectorPath(sector)}
              />
            ))}
          </>
        )}
      </svg>
      {wheel.map((point, i) => {
        const tile = tiles?.[i];
        const [x, y] = wheelPosition(point.hue, point.chroma);
        const f = bySlot[point.slotId];
        const classes = [
          'harmony-dot',
          tile?.outside ? 'outside' : '',
          tile && tile.weight === 0 ? 'weightless' : '',
          selected.has(point.slotId) ? 'selected' : '',
        ].filter(Boolean);
        const note = tile?.outside ? ` · вне шаблона на ${tile.distance.toFixed(1)}°` : '';
        return (
          <button
            key={point.slotId}
            className={classes.join(' ')}
            style={{
              left: `${50 + x * 50}%`,
              top: `${50 + y * 50}%`,
              backgroundColor: f ? cssRgb(labToSrgb8([f.meanL, f.meanA, f.meanB])) : undefined,
            }}
            data-testid="harmony-point"
            data-slot-id={point.slotId}
            data-hue={point.hue}
            data-chroma={point.chroma}
            data-outside={tile?.outside ?? false}
            data-distance={tile?.distance}
            aria-pressed={selected.has(point.slotId)}
            title={`Тон ${Math.round(point.hue)}° · хрома ${point.chroma.toFixed(3)}${note}`}
            onClick={(event) => onClick(event, point.slotId)}
          />
        );
      })}
    </div>
  );
}

/** Все шаблоны с их оценкой: лучший — с наименьшей ценой «остаток без далёких плиток + ширина». */
function HarmonyFits({ harmony }: { harmony: Extract<Harmony, { kind: 'template' }> }) {
  return (
    <details className="rhythm-fits">
      <summary className="muted">Все шаблоны</summary>
      <ul>
        {harmony.fits.map((fit) => (
          <li
            key={fit.template}
            className={fit === harmony.best ? 'chosen' : undefined}
            data-testid="harmony-fit"
            data-template={fit.template}
            data-score={fit.score}
            data-cost={fit.cost}
          >
            <span>
              {fit.template} — {HARMONY_LABELS[fit.template].toLowerCase()}
            </span>
            <span className="muted">{fit.score.toFixed(1)}°</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
