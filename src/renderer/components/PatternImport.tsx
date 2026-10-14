// «Импорт паттерна» (spec, «Модуль 4. Паттерны»; docs/decisions/0024-pattern-image.md): слой поверх окна, как
// редактор фото. Картинка-шаблон на холсте 2D, поверх — найденная сетка 3 × N: края рамки и ячеек тянутся мышью,
// число рядов задаётся полем. Рядом — цели ячеек и устойчивость к сдвигу. «Применить» пишет паттерн и цели всех
// позиций одной записью истории; Esc и «Отмена» закрывают слой, проект не меняется. Сетку, цели и правку сетки
// считает core/pattern/image.ts; картинка в проект не пишется.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  cellRect,
  detectGrid,
  dragGridLine,
  extractCells,
  gridFrame,
  gridLines,
  imageLab,
  imagePattern,
  setGridRows,
  type GridAxis,
  type GridLine,
  type ImageCell,
  type ImageGrid,
  type LabImage,
} from '@core/pattern/image';
import { PATTERN_MAX_ROWS } from '@core/pattern/pattern';
import type { Ratio } from '@core/project/types';
import type { PatternImage } from '@shared/ipc';
import { applyImagePattern, closePatternImport } from '../commands';
import { plural } from '../plural';
import { useAppStore, type PatternImport as PatternImportState } from '../store';
import { PatternPreview, PostingModeNote } from './PatternPreview';

/** Поле вокруг картинки на сцене, CSS px: края сетки у края картинки можно ухватить. */
const STAGE_PADDING = 24;
/** Ширина зоны захвата линии сетки, CSS px. */
const HANDLE_WIDTH = 10;

type Rect = [number, number, number, number];

export function PatternImport() {
  const source = useAppStore((state) => state.patternImport);
  const ratio = useAppStore((state) => state.snapshot?.project.grid.ratio);
  if (!source || !ratio) return null;
  // Новая картинка — новый слой: свои холст, пиксели и ручная сетка.
  return <ImportView key={source.id} source={source} ratio={ratio} />;
}

function ImportView({ source, ratio }: { source: PatternImportState; ratio: Ratio }) {
  const { image, file } = source;
  const [lab, setLab] = useState<LabImage | null>(null);
  // OKLab точек — в эффекте и отпускается при размонтаже. В dev StrictMode эффект монтируется дважды —
  // каждый раз считаются свои пиксели, прежние не переиспользуются.
  useEffect(() => {
    setLab(imageLab(image));
    return () => setLab(null);
  }, [image]);
  const detection = useMemo(() => (lab ? detectGrid(lab, ratio) : null), [lab, ratio]);
  /** Ручная правка поверх найденной сетки; null — сетка как её нашли. */
  const [manual, setManual] = useState<ImageGrid | null>(null);
  const grid = manual ?? detection?.grid ?? null;
  const cells = useMemo(() => (lab && grid ? extractCells(lab, grid) : null), [lab, grid]);
  const pattern = useMemo(() => (cells ? imagePattern(cells) : null), [cells]);

  return (
    <div
      className="pattern-import"
      role="dialog"
      aria-label="Импорт паттерна"
      data-testid="pattern-import"
      data-state={pattern ? 'ready' : 'loading'}
      data-image-width={image.width}
      data-image-height={image.height}
    >
      <header className="editor-header">
        <strong>Импорт паттерна</strong>
        <span className="muted pattern-import-file" title={file}>
          {file} · {image.width} × {image.height}
        </span>
        <div className="spacer" />
        <button title="Esc" onClick={closePatternImport}>
          Отмена
        </button>
        <button
          className="primary"
          disabled={!pattern}
          title="Паттерн и цели всех позиций — одной записью истории"
          onClick={() => pattern && applyImagePattern(pattern)}
        >
          Применить
        </button>
      </header>
      <div className="editor-body">
        <ImportStage image={image} grid={grid} cells={cells} onGrid={setManual} />
        <aside className="inspector editor-panel" data-testid="pattern-import-panel">
          {grid && detection && pattern ? (
            <>
              <header className="inspector-header">
                <h2>Сетка</h2>
                <button className="link" disabled={manual === null} onClick={() => setManual(null)} title="Вернуть найденную сетку">
                  Сбросить
                </button>
              </header>
              <GridStatus found={detection.found} grid={grid} manual={manual !== null} />
              <label className="field field-inline">
                <span>Рядов</span>
                <input
                  type="number"
                  aria-label="Рядов"
                  min={1}
                  max={PATTERN_MAX_ROWS}
                  step={1}
                  value={grid.rows}
                  onChange={(e) => {
                    const rows = Math.round(Number(e.currentTarget.value));
                    if (Number.isFinite(rows) && rows >= 1) setManual(setGridRows(grid, rows));
                  }}
                />
              </label>
              <GridNumbers grid={grid} />
              <p className="muted">
                Тяните мышью края сетки — поля, и края ячеек — промежутки. Ячейки остаются равными; цель — среднее
                центральных 60% ячейки (пунктир на картинке).
              </p>
              <h3>Цели</h3>
              <PatternPreview pattern={pattern} />
              <p className="muted">
                Пунктирная рамка — мягкая цель: в ячейке фото, допуски шире. У серой ячейки тон и хрома не задаются.
              </p>
              <PostingModeNote pattern={pattern} />
            </>
          ) : (
            <p className="muted">Ищем сетку…</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function GridStatus({ found, grid, manual }: { found: { columns: boolean; rows: boolean }; grid: ImageGrid; manual: boolean }) {
  const size = `3 × ${grid.rows}`;
  const text = manual
    ? `Сетка ${size}, поправлена вручную.`
    : found.columns && found.rows
      ? `Найдена сетка ${size}.`
      : found.columns || found.rows
        ? `Сетка ${size}: ${found.columns ? 'ряды' : 'колонки'} не нашлись — размечены по пропорциям сетки, поправьте вручную.`
        : `Сетку не нашли: вся картинка — ${size} по пропорциям сетки. Поправьте вручную.`;
  return (
    <p className="grid-status" data-testid="grid-status" data-found-columns={found.columns} data-found-rows={found.rows}>
      {text}
    </p>
  );
}

function GridNumbers({ grid }: { grid: ImageGrid }) {
  const px = (v: number) => Math.round(v);
  return (
    <dl className="analysis-stats">
      <dt>Поля</dt>
      <dd>
        слева {px(grid.left)}, сверху {px(grid.top)} px
      </dd>
      <dt>Ячейка</dt>
      <dd>
        {px(grid.cellWidth)} × {px(grid.cellHeight)} px
      </dd>
      <dt>Промежуток</dt>
      <dd>
        {px(grid.gapX)} × {px(grid.gapY)} px
      </dd>
      <dt>Период</dt>
      <dd>
        {grid.rows} {plural(grid.rows, 'ряд', 'ряда', 'рядов')}
      </dd>
    </dl>
  );
}

// ─── Сцена: картинка на холсте 2D и сетка поверх ───────────────────────────

function ImportStage({
  image,
  grid,
  cells,
  onGrid,
}: {
  image: PatternImage;
  grid: ImageGrid | null;
  cells: ImageCell[] | null;
  onGrid: (grid: ImageGrid) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setSize([stage.clientWidth, stage.clientHeight]);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Холст и его пиксели создаются здесь и отпускаются при размонтаже. В dev StrictMode эффект монтируется
  // дважды: второй раз — новый холст, первый уже убран.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'pattern-canvas';
    canvas.dataset['testid'] = 'pattern-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = image.width;
    canvas.height = image.height;
    // Пиксели из IPC — свой ArrayBuffer (structured clone), не общий: представление без копии.
    const pixels = new Uint8ClampedArray(image.data.buffer as ArrayBuffer, image.data.byteOffset, image.data.byteLength);
    canvas.getContext('2d')?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
    holder.append(canvas);
    return () => {
      // Нулевой размер отпускает память холста сразу, не дожидаясь сборщика.
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    };
  }, [image]);

  const rect = fitRect(size, image.width, image.height);
  const style = { left: rect[0], top: rect[1], width: rect[2], height: rect[3] };
  return (
    <div className="editor-stage pattern-stage" ref={stageRef} data-testid="pattern-stage">
      <div className="pattern-image" ref={holderRef} style={style} />
      {grid && cells && rect[2] > 0 && <GridOverlay image={image} grid={grid} cells={cells} rect={rect} onGrid={onGrid} />}
    </div>
  );
}

/** Картинка целиком внутри сцены, по центру; целые CSS-пиксели. */
function fitRect([width, height]: [number, number], imageW: number, imageH: number): Rect {
  const scale = Math.min((width - 2 * STAGE_PADDING) / imageW, (height - 2 * STAGE_PADDING) / imageH);
  if (!(scale > 0)) return [0, 0, 0, 0];
  const w = Math.round(imageW * scale);
  const h = Math.round(imageH * scale);
  return [Math.round((width - w) / 2), Math.round((height - h) / 2), w, h];
}

interface GridDrag {
  pointerId: number;
  axis: GridAxis;
  line: GridLine;
  /** Сетка в начале жеста: правка считается от неё, а не накапливается. */
  start: ImageGrid;
  /** Позиция линии в начале жеста: при нулевом промежутке край ячейки выбирается по направлению. */
  from: number;
}

/**
 * Сетка поверх картинки, в координатах картинки (viewBox). Вне рамки — затемнение; ячейки — контуры, поле замера —
 * пунктир; края рамки и ячеек — зоны захвата.
 */
function GridOverlay({
  image,
  grid,
  cells,
  rect,
  onGrid,
}: {
  image: PatternImage;
  grid: ImageGrid;
  cells: ImageCell[];
  rect: Rect;
  onGrid: (grid: ImageGrid) => void;
}) {
  const drag = useRef<GridDrag | null>(null);
  const { width: W, height: H } = image;
  const frame = gridFrame(grid);
  /** Точек картинки в одном CSS-пикселе: линии и зоны захвата одного размера на экране. */
  const unit = W / rect[2];

  const locate = (event: { clientX: number; clientY: number; currentTarget: Element }): [number, number] => {
    const r = event.currentTarget.getBoundingClientRect();
    return [((event.clientX - r.left) / r.width) * W, ((event.clientY - r.top) / r.height) * H];
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || drag.current) return;
    const target = event.target as Element;
    const axis = target.getAttribute('data-axis');
    const index = Number(target.getAttribute('data-line-index'));
    if (axis !== 'x' && axis !== 'y') return;
    const entry = gridLines(grid, axis)[index];
    if (!entry) return;
    drag.current = { pointerId: event.pointerId, axis, line: entry.line, start: grid, from: entry.position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const [x, y] = locate(event);
    const position = d.axis === 'x' ? x : y;
    onGrid(dragGridLine(d.start, d.axis, coincidentLine(d, position), position, { width: W, height: H }));
  };

  const onPointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const shade = `M0 0H${W}V${H}H0Z M${frame.left} ${frame.top}V${frame.bottom}H${frame.right}V${frame.top}Z`;
  return (
    <svg
      className="pattern-grid"
      style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      data-testid="image-grid"
      data-left={grid.left}
      data-top={grid.top}
      data-cell-width={grid.cellWidth}
      data-cell-height={grid.cellHeight}
      data-gap-x={grid.gapX}
      data-gap-y={grid.gapY}
      data-rows={grid.rows}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <path className="pattern-grid-shade" fillRule="evenodd" d={shade} />
      {cells.map((cell) => {
        const r = cellRect(grid, cell.row, cell.column);
        const s = cell.sample;
        return (
          <g key={cell.index}>
            <rect className="pattern-grid-cell" x={r.x} y={r.y} width={r.w} height={r.h} />
            <rect className="pattern-grid-sample" x={s.x0} y={s.y0} width={s.x1 - s.x0} height={s.y1 - s.y0} />
          </g>
        );
      })}
      {(['x', 'y'] as const).flatMap((axis) =>
        gridLines(grid, axis).map(({ line, position }, i) => {
          const along = axis === 'x' ? [frame.top, frame.bottom] : [frame.left, frame.right];
          const [x1, y1, x2, y2] =
            axis === 'x' ? [position, along[0], position, along[1]] : [along[0], position, along[1], position];
          return (
            <line
              key={`${axis}${i}`}
              className={`pattern-grid-handle ${axis}`}
              data-testid="grid-line"
              data-axis={axis}
              data-line={line.kind}
              data-line-index={i}
              data-position={position}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeWidth={HANDLE_WIDTH * unit}
            />
          );
        }),
      )}
    </svg>
  );
}

/**
 * При нулевом промежутке конец ячейки j − 1 и начало ячейки j — одна линия: тянут влево — это конец ячейки
 * (промежуток открывается слева), вправо — начало следующей.
 */
function coincidentLine(drag: GridDrag, position: number): GridLine {
  const { line, start, axis } = drag;
  const gap = axis === 'x' ? start.gapX : start.gapY;
  if (gap > 0 || line.kind !== 'cell-start' || position >= drag.from) return line;
  return { kind: 'cell-end', cell: line.cell - 1 };
}
