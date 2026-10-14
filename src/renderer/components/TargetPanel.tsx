// Вкладка «Цель» инспектора (spec, «Модуль 4. Паттерны»; docs/decisions/0023-patterns.md): паттерн из генератора
// или строки-шаблона, превью периода, устойчивость к сдвигу, «Применить к сетке» и «Убрать цели»; паттерн из
// изображения (ADR 0024) — в «Импорте паттерна» поверх окна; цель выбранной позиции; подгонка сетки и поправки
// к цели (ADR 0025, FitSection.tsx); план контента (ADR 0026, ContentPlanSection.tsx). Клетки, цели, режим
// публикации и план считает core (`core/pattern/`); параметры генератора и строка — черновик в сторе, в проект
// пишутся только паттерн и цели позиций одной записью истории.
import { useMemo } from 'react';
import { formatPart } from '@core/harmony/outliers';
import {
  GENERATOR_LABELS,
  GENERATOR_TEMPLATES,
  GRADIENT_LABELS,
  generatorLevels,
  WARMTH_RANGE,
  type GeneratorParams,
  type GeneratorTemplate,
  type GradientKind,
} from '@core/pattern/generator';
import {
  DEFAULT_LEVELS,
  LEVEL_CENTER_RANGE,
  LEVEL_CONTRAST_RANGE,
  LEVEL_LABELS,
  type Level,
  type LevelParams,
  type TargetColor,
} from '@core/pattern/levels';
import { PATTERN_SOURCE_LABELS, periodCell, POSTING_MODE_LABELS } from '@core/pattern/pattern';
import type { Project } from '@core/project/types';
import { useGridAnalysis } from '../analysis';
import { applyPatternToGrid, clearPattern, editGeneratorParams, editPatternDraft, openPatternImage } from '../commands';
import { ContentPlanSection } from './ContentPlanSection';
import { draftPattern, targetCss, type PatternDraft, type PatternSource } from '../pattern';
import { plural } from '../plural';
import { useAppStore } from '../store';
import { FitSection, TargetFixesSection } from './FitSection';
import { PatternPreview, PostingModeNote, targetTitle } from './PatternPreview';
import { Slider } from './Slider';

/** Цвет уровня, который ставит флажок «Цвет»: тёплый светлый, нейтрально-голубой средний, холодный тёмный. */
const DEFAULT_LEVEL_COLORS: Record<Level, TargetColor> = {
  L: { hue: 70, chroma: 0.05 },
  M: { hue: 200, chroma: 0.04 },
  D: { hue: 250, chroma: 0.05 },
};
/** Хрома в полях цвета — не больше: дальше почти все тона за охватом sRGB. */
const CHROMA_INPUT_MAX = 0.3;
/** Период градиента в поле — не больше: длиннее — уже не градиент, а почти ровная сетка. */
const GRADIENT_ROWS_MAX = 12;

const SOURCES: { id: PatternSource; label: string }[] = [
  { id: 'generator', label: 'Генератор' },
  { id: 'string', label: 'Строка' },
];

export function TargetPanel({ project }: { project: Project }) {
  const draft = useAppStore((state) => state.patternDraft);
  const preview = useMemo(() => draftPattern(draft), [draft]);
  const hasTargets = project.pattern !== undefined || project.slots.some((slot) => slot.target !== undefined);

  return (
    <div className="target-panel" data-testid="target-panel">
      <header className="inspector-header">
        <h2>Цель</h2>
      </header>
      <h3>Паттерн</h3>
      <CurrentPattern project={project} />
      <div className="segmented" role="group" aria-label="Источник паттерна">
        {SOURCES.map(({ id, label }) => (
          <button key={id} aria-pressed={draft.source === id} onClick={() => editPatternDraft({ source: id })}>
            {label}
          </button>
        ))}
      </div>
      {draft.source === 'generator' ? <GeneratorControls params={draft.generator} /> : <StringControls text={draft.text} />}
      <LevelControls draft={draft} />
      {preview.ok ? (
        <>
          <PatternPreview pattern={preview.pattern} />
          <PostingModeNote pattern={preview.pattern} />
        </>
      ) : (
        <p className="pattern-error" role="alert" data-testid="pattern-error">
          {preview.error}
        </p>
      )}
      <div className="button-row">
        <button className="primary" disabled={!preview.ok} onClick={() => preview.ok && applyPatternToGrid(preview.pattern)}>
          Применить к сетке
        </button>
        <button disabled={!hasTargets} onClick={clearPattern} title="Убрать паттерн и цели всех позиций">
          Убрать цели
        </button>
      </div>
      <h3>Из изображения</h3>
      <ImageSource />
      <h3>Позиция</h3>
      <PositionTarget project={project} />
      <h3>Подгонка</h3>
      <FitSection project={project} />
      <h3>Поправки к цели</h3>
      <TargetFixesSection project={project} />
      <h3>План контента</h3>
      <ContentPlanSection project={project} />
    </div>
  );
}

/** «Из изображения…»: картинку спрашивает main; сетку и цели показывает «Импорт паттерна». */
function ImageSource() {
  const error = useAppStore((state) => state.patternImageError);
  return (
    <div className="image-source" data-testid="image-source">
      <p className="muted">
        Картинка с квадратами 3 × N — шаблон из Pinterest, Canva или свой рисунок. Сетку найдём сами, её можно поправить;
        у заливки цель жёсткая, у фото в ячейке — мягкая.
      </p>
      <button onClick={() => void openPatternImage()}>Из изображения…</button>
      {error && (
        <p className="pattern-error" role="alert" data-testid="pattern-image-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Паттерн проекта сейчас: источник, период и режим публикации. */
function CurrentPattern({ project }: { project: Project }) {
  const { pattern } = project;
  if (!pattern) {
    const targets = project.slots.filter((slot) => slot.target !== undefined).length;
    return (
      <p className="muted" data-testid="current-pattern" data-state="none">
        Паттерна нет: режим 7 и выбросы сверяют плитки с сеткой
        {targets > 0 ? ` (у ${targets} ${plural(targets, 'позиции', 'позиций', 'позиций')} цели из файла проекта)` : ''}.
      </p>
    );
  }
  return (
    <p
      className="current-pattern"
      data-testid="current-pattern"
      data-state="pattern"
      data-source={pattern.source}
      data-period-rows={pattern.periodRows}
      data-posting-mode={pattern.postingMode}
    >
      В сетке: {PATTERN_SOURCE_LABELS[pattern.source]}, период {pattern.periodRows}{' '}
      {plural(pattern.periodRows, 'ряд', 'ряда', 'рядов')} · {POSTING_MODE_LABELS[pattern.postingMode].toLowerCase()}
    </p>
  );
}

function GeneratorControls({ params }: { params: GeneratorParams }) {
  const { template } = params;
  return (
    <>
      <label className="field">
        <span>Шаблон</span>
        <select
          className="look-select"
          aria-label="Шаблон"
          value={template}
          onChange={(e) => editGeneratorParams({ template: e.currentTarget.value as GeneratorTemplate })}
        >
          {GENERATOR_TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {GENERATOR_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {(template === 'rows' || template === 'columns') && (
        <label className="field">
          <span>Уровней</span>
          <select
            className="look-select"
            aria-label="Уровней"
            value={params.levels}
            onChange={(e) => editGeneratorParams({ levels: Number(e.currentTarget.value) === 3 ? 3 : 2 })}
          >
            <option value={2}>2 — светлый и тёмный</option>
            <option value={3}>3 — светлый, средний, тёмный</option>
          </select>
        </label>
      )}
      {template === 'gradient' && (
        <>
          <label className="field">
            <span>Направление</span>
            <select
              className="look-select"
              aria-label="Направление"
              value={params.gradient}
              onChange={(e) => editGeneratorParams({ gradient: e.currentTarget.value as GradientKind })}
            >
              {(['lighter', 'warmer'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {GRADIENT_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span>Период, рядов</span>
            <input
              type="number"
              aria-label="Период, рядов"
              min={1}
              max={GRADIENT_ROWS_MAX}
              step={1}
              value={params.periodRows}
              onChange={(e) => {
                const value = Math.round(Number(e.currentTarget.value));
                if (Number.isFinite(value) && value >= 1) editGeneratorParams({ periodRows: Math.min(GRADIENT_ROWS_MAX, value) });
              }}
            />
          </label>
          {params.gradient === 'warmer' && (
            <Slider
              label="Размах тепла"
              value={params.warmth}
              min={WARMTH_RANGE[0]}
              max={WARMTH_RANGE[1]}
              step={0.01}
              disabled={false}
              testId="value-warmth"
              format={(v) => v.toFixed(2)}
              onChange={(warmth) => editGeneratorParams({ warmth })}
              onReset={() => editGeneratorParams({ warmth: 0.08 })}
            />
          )}
        </>
      )}
      {template === 'twoColors' ? (
        <>
          {params.pair.map((color, i) => (
            <ColorInputs
              key={i}
              name={`Цвет ${i + 1}`}
              color={color}
              onChange={(next) => editGeneratorParams({ pair: i === 0 ? [next, params.pair[1]] : [params.pair[0], next] })}
            />
          ))}
        </>
      ) : (
        generatorLevels(params).map((level) => <LevelColor key={level} level={level} template={template} params={params} />)
      )}
    </>
  );
}

/** Флажок «Цвет» уровня и, если он стоит, тон и хрома. У градиента цвет уровня M — цвет всех клеток или середина. */
function LevelColor({ level, template, params }: { level: Level; template: GeneratorTemplate; params: GeneratorParams }) {
  const color = params.colors[level];
  const name = template === 'gradient' ? 'Цвет' : `Цвет ${level}`;
  const setColor = (next: TargetColor | undefined) => {
    const colors = { ...params.colors };
    if (next) colors[level] = next;
    else delete colors[level];
    editGeneratorParams({ colors });
  };
  return (
    <div className="level-color">
      <label className="check" title={template === 'gradient' ? 'Цвет клеток градиента' : `Цвет уровня «${LEVEL_LABELS[level]}»`}>
        <input
          type="checkbox"
          aria-label={name}
          checked={color !== undefined}
          onChange={(e) => setColor(e.currentTarget.checked ? DEFAULT_LEVEL_COLORS[level] : undefined)}
        />
        {name}
        {template !== 'gradient' && <span className="muted"> — {LEVEL_LABELS[level]}</span>}
      </label>
      {color && <ColorInputs name={name} color={color} onChange={setColor} />}
    </div>
  );
}

/** Тон и хрома цвета цели, с образцом. */
function ColorInputs({ name, color, onChange }: { name: string; color: TargetColor; onChange: (color: TargetColor) => void }) {
  const hue = color.hue ?? 0;
  return (
    <div className="color-inputs">
      <span className="color-swatch" style={{ backgroundColor: targetCss({ L: 0.62, hue, chroma: color.chroma }) }} title={name} />
      <label>
        <span className="muted">Тон</span>
        <input
          type="number"
          aria-label={`${name}: тон`}
          min={0}
          max={359}
          step={1}
          value={hue}
          onChange={(e) => {
            const value = Number(e.currentTarget.value);
            if (Number.isFinite(value)) onChange({ ...color, hue: ((value % 360) + 360) % 360 });
          }}
        />
      </label>
      <label>
        <span className="muted">Хрома</span>
        <input
          type="number"
          aria-label={`${name}: хрома`}
          min={0}
          max={CHROMA_INPUT_MAX}
          step={0.01}
          value={color.chroma}
          onChange={(e) => {
            const value = Number(e.currentTarget.value);
            if (Number.isFinite(value)) onChange({ ...color, chroma: Math.min(CHROMA_INPUT_MAX, Math.max(0, value)) });
          }}
        />
      </label>
    </div>
  );
}

function StringControls({ text }: { text: string }) {
  return (
    <label className="field">
      <span>Строка-шаблон</span>
      <textarea
        className="pattern-string"
        aria-label="Строка-шаблон"
        rows={3}
        spellCheck={false}
        value={text}
        placeholder="LDL/DLD"
        onChange={(e) => editPatternDraft({ text: e.currentTarget.value })}
      />
      <span className="muted">
        L, M, D — светлый, средний, тёмный; по три в ряду, ряды — через / или с новой строки. Период — число рядов.
      </span>
    </label>
  );
}

/** Середина и контраст уровней. Контраст не нужен двум цветам и градиенту «теплее»: у них L — середина. */
function LevelControls({ draft }: { draft: PatternDraft }) {
  const { levels } = draft;
  const { template, gradient } = draft.generator;
  const centerOnly = draft.source === 'generator' && (template === 'twoColors' || (template === 'gradient' && gradient === 'warmer'));
  const set = (change: Partial<LevelParams>) => editPatternDraft({ levels: { ...levels, ...change } });
  return (
    <>
      <Slider
        label="Середина"
        value={levels.center}
        min={LEVEL_CENTER_RANGE[0]}
        max={LEVEL_CENTER_RANGE[1]}
        step={0.01}
        disabled={false}
        testId="value-center"
        format={(v) => v.toFixed(2)}
        onChange={(center) => set({ center })}
        onReset={() => set({ center: DEFAULT_LEVELS.center })}
      />
      {!centerOnly && (
        <Slider
          label="Контраст"
          value={levels.contrast}
          min={LEVEL_CONTRAST_RANGE[0]}
          max={LEVEL_CONTRAST_RANGE[1]}
          step={0.01}
          disabled={false}
          testId="value-contrast"
          format={(v) => v.toFixed(2)}
          onChange={(contrast) => set({ contrast })}
          onReset={() => set({ contrast: DEFAULT_LEVELS.contrast })}
        />
      )}
    </>
  );
}

/** Цель основной выделенной позиции: L, тон, хрома, допуски, жёсткая или мягкая, клетка периода; и где сейчас плитка. */
function PositionTarget({ project }: { project: Project }) {
  const primary = useAppStore((state) => state.selection.primary);
  const analysis = useGridAnalysis(project);
  const index = project.slots.findIndex((slot) => slot.id === primary);
  const slot = project.slots[index];
  if (!slot) return <p className="muted">Выберите плитку — здесь будет цель её позиции.</p>;
  const number = index + 1;
  if (index < project.grid.pinned) {
    return (
      <p className="muted" data-testid="position-target" data-state="pinned" data-index={index}>
        Позиция {number} закреплена: она вне ленты, цели у неё нет.
      </p>
    );
  }
  const { target } = slot;
  if (!target) {
    return (
      <p className="muted" data-testid="position-target" data-state="none" data-index={index}>
        У позиции {number} нет цели{project.pattern ? '' : ': примените паттерн к сетке'}.
      </p>
    );
  }
  const cell = project.pattern ? periodCell(project.pattern, index) : undefined;
  const expectation = analysis.expectations.find((e) => e.slotId === slot.id && e.source === 'target');
  const { tolerance } = target;
  return (
    <div
      className="position-target"
      data-testid="position-target"
      data-state="target"
      data-index={index}
      data-l={target.L}
      data-hue={target.hue}
      data-chroma={target.chroma}
      data-hard={target.hard}
      data-cell={cell?.cell}
    >
      <span className="target-swatch" style={{ backgroundColor: targetCss(target) }} title={targetTitle(target)} />
      <dl className="analysis-stats">
        <dt>Позиция</dt>
        <dd>
          {number}
          {cell && (
            <span className="muted">
              {' '}
              · клетка периода: ряд {cell.row + 1}, колонка {cell.column + 1}
            </span>
          )}
        </dd>
        <dt>Яркость</dt>
        <dd>
          L {target.L.toFixed(2)} <span className="muted">± {tolerance.L}</span>
        </dd>
        <dt>Тон</dt>
        <dd>{target.hue !== undefined ? <>{Math.round(target.hue)}° <span className="muted">± {tolerance.hue}°</span></> : 'любой'}</dd>
        <dt>Хрома</dt>
        <dd>
          {target.chroma !== undefined ? (
            <>
              {target.chroma.toFixed(3)} <span className="muted">± {tolerance.chroma}</span>
            </>
          ) : (
            'любая'
          )}
        </dd>
        <dt>Цель</dt>
        <dd>{target.hard ? 'жёсткая — заливка шаблона' : 'мягкая — снята с фото'}</dd>
        {expectation && (
          <>
            <dt>Плитка</dt>
            <dd data-testid="position-deviation" data-deviation={expectation.deviation}>
              {expectation.reasons.length === 0
                ? 'в допуске'
                : expectation.reasons.map((part) => formatPart(part)).join('; ')}
            </dd>
          </>
        )}
      </dl>
      {slot.state === 'empty' && <p className="muted">Пустая позиция: сюда нужен пост с такой целью.</p>}
      {slot.state === 'published' && <p className="muted">Опубликованный пост: цель позиции — контекст плана, он не правится.</p>}
    </div>
  );
}
