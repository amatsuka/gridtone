import { useEffect, useState } from 'react';
import { LUT_CHECK_LIMITS, type LutCheck, type LutExportSize } from '@core/lut/verify';
import type { Look } from '@core/project/types';
import type { ExportProgress, ExportStarted } from '@shared/ipc';
import { closeExportDialog } from '../commands';
import { lutCheckKey, requestLutCheck, useLutChecks, type LutCheckResult } from '../lutCheck';
import { lookLut, useLutStore, type LookLut } from '../luts';
import { api, useAppStore } from '../store';

/** Экран «Экспорт» (spec, «Экраны»). Этап 3а — раздел LUT (docs/decisions/0014-lut-export.md). */
export function ExportDialog() {
  const open = useAppStore((state) => state.exportOpen);
  return open ? <ExportForm /> : null;
}

type RunState = { state: 'idle' } | { state: 'starting' } | { state: 'started'; job: ExportStarted } | { state: 'error'; message: string };

function ExportForm() {
  const snapshot = useAppStore((state) => state.snapshot);
  const progress = useAppStore((state) => state.exportProgress);
  const checks = useLutChecks((state) => state.byKey);
  const lutFiles = useAppStore((state) => state.snapshot?.luts);
  const lutTables = useLutStore((state) => state.byId);
  const looks = snapshot?.project.looks ?? [];
  // По умолчанию отмечены все образы и оба формата.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(looks.map((look) => look.id)));
  /** Размер, выбранный вручную; без выбора — по проверке. */
  const [sizes, setSizes] = useState<Readonly<Record<string, LutExportSize>>>({});
  const [cube, setCube] = useState(true);
  const [hald, setHald] = useState(true);
  const [run, setRun] = useState<RunState>({ state: 'idle' });

  // LUT образа входит в проверку (ADR 0015): пока его таблица едет из main, проверка ждёт.
  useEffect(() => {
    for (const look of looks) {
      const lut = lookLut(look, lutFiles, lutTables);
      if (lut.state === 'none' || lut.state === 'ready') requestLutCheck(look.adjust, loaded(lut));
    }
  }, [looks, lutFiles, lutTables]);

  if (!snapshot) return null;
  const chosen = looks.filter((look) => selected.has(look.id));
  const resultOf = (look: Look): LutCheckResult | undefined => {
    const lut = lookLut(look, lutFiles, lutTables);
    if (lut.state === 'missing') return { ok: false, error: lut.error };
    if (lut.state === 'loading') return undefined;
    return checks[lutCheckKey(look.adjust, loaded(lut))];
  };
  const sizeOf = (look: Look): LutExportSize | undefined => {
    const result = resultOf(look);
    return sizes[look.id] ?? (result?.ok ? result.choice.size : result ? 33 : undefined);
  };
  const job = run.state === 'started' ? run.job : null;
  const current = job && progress?.jobId === job.jobId ? progress : null;
  const running = run.state === 'starting' || (job !== null && !current?.finished);
  const ready = chosen.length > 0 && (cube || hald) && chosen.every((look) => !cube || sizeOf(look) !== undefined);

  const toggle = (id: string) =>
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const start = async () => {
    setRun({ state: 'starting' });
    try {
      const started = await api.invoke('export:run', {
        dir: snapshot.dir,
        lut: { looks: chosen.map((look) => ({ id: look.id, size: sizeOf(look) ?? 33 })), cube, hald },
      });
      setRun(started ? { state: 'started', job: started } : { state: 'idle' });
    } catch (err) {
      setRun({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && closeExportDialog()}>
      <form
        className="dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        data-testid="export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !running) void start();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          closeExportDialog();
        }}
      >
        <h2 id="export-dialog-title">Экспорт</h2>

        <section className="export-section">
          <h3>LUT образов</h3>
          {looks.length === 0 ? (
            <p className="muted">Образов пока нет: LUT экспортируется из образа, вкладка «Образ» в инспекторе.</p>
          ) : (
            <ul className="lut-looks">
              {looks.map((look) => (
                <LookRow
                  key={look.id}
                  look={look}
                  checked={selected.has(look.id)}
                  onToggle={() => toggle(look.id)}
                  result={resultOf(look)}
                  size={sizeOf(look)}
                  onSize={(size) => setSizes((now) => ({ ...now, [look.id]: size }))}
                />
              ))}
            </ul>
          )}
          <div className="export-formats">
            <label className="check">
              <input type="checkbox" checked={cube} onChange={() => setCube((v) => !v)} />
              .cube
            </label>
            <label className="check">
              <input type="checkbox" checked={hald} onChange={() => setHald((v) => !v)} />
              HaldCLUT PNG
            </label>
          </div>
          <p className="muted export-note">
            .cube — 33 или 65 узлов, по проверке по кругу. HaldCLUT — уровень 8 (64³), PNG 512 × 512, 16 бит. Вход и
            выход — sRGB с гаммой.
          </p>
          <Recipes />
        </section>

        {run.state === 'error' && (
          <p className="export-error" role="alert">
            {run.message}
          </p>
        )}
        {job && <Result dir={job.dir} progress={current} />}

        <div className="dialog-actions">
          <div className="spacer" />
          <button type="button" onClick={closeExportDialog}>
            Закрыть
          </button>
          <button type="submit" className="primary" disabled={!ready || running}>
            {running ? 'Экспорт…' : 'Экспортировать…'}
          </button>
        </div>
      </form>
    </div>
  );
}

function LookRow({
  look,
  checked,
  onToggle,
  result,
  size,
  onSize,
}: {
  look: Look;
  checked: boolean;
  onToggle: () => void;
  result: LutCheckResult | undefined;
  size: LutExportSize | undefined;
  onSize: (size: LutExportSize) => void;
}) {
  const choice = result?.ok ? result.choice : undefined;
  return (
    <li className="lut-look" data-testid="lut-look" data-name={look.name}>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        {look.name}
      </label>
      <div className="lut-size" role="radiogroup" aria-label={`Размер .cube «${look.name}»`}>
        {([33, 65] as const).map((option) => (
          <label key={option}>
            <input type="radio" name={`size-${look.id}`} checked={size === option} onChange={() => onSize(option)} />
            {option}
          </label>
        ))}
      </div>
      <div
        className="lut-check"
        data-testid="lut-check"
        data-state={!result ? 'pending' : !choice ? 'error' : choice.checks[33].pass ? 'pass' : 'fail'}
        data-state65={!choice?.checks[65] ? '' : choice.checks[65].pass ? 'pass' : 'fail'}
      >
        {!result ? (
          <span className="muted">Проверка по кругу…</span>
        ) : !choice ? (
          <span className="export-error">Проверка не удалась: {result.ok ? '' : result.error}</span>
        ) : (
          <>
            <CheckLine size={33} check={choice.checks[33]} />
            {choice.checks[65] && <CheckLine size={65} check={choice.checks[65]} />}
          </>
        )}
      </div>
    </li>
  );
}

const f2 = (v: number) => v.toFixed(2);

function loaded(lut: LookLut) {
  return lut.state === 'ready' ? lut : null;
}

/** «33: подходит · ΔE ср. 0.03, 99% 0.35» и строкой ниже трилинейная, как в Resolve. */
function CheckLine({ size, check }: { size: LutExportSize; check: LutCheck }) {
  const { tetrahedral: t, trilinear: l } = check;
  const trilinearOk = l.mean < LUT_CHECK_LIMITS.mean && l.p99 < LUT_CHECK_LIMITS.p99;
  return (
    <div className={`check-line ${check.pass ? 'pass' : 'fail'}`}>
      <span>
        {size}: {check.pass ? 'подходит' : 'не подходит'} · ΔE2000 ср. {f2(t.mean)}, 99% {f2(t.p99)}
      </span>
      <span className="muted" title="Resolve по умолчанию применяет LUT трилинейной интерполяцией">
        трилинейная: {f2(l.mean)} / {f2(l.p99)}
        {trilinearOk ? '' : ' — грубее порога'}
      </span>
    </div>
  );
}

/** Куда ставить LUT — по таблице спеки, Photoshop первым (план этапа 3). */
function Recipes() {
  return (
    <details className="recipes">
      <summary>Куда ставить LUT</summary>
      <p className="muted">
        На входе LUT должно быть то же изображение, что вы загрузили в Gridtone: базовая версия после проявки, до
        стилизации.
      </p>
      <ul>
        <li>
          <b>Photoshop</b> — корректирующий слой «Поиск цвета» (Color Lookup) поверх базовой версии, «Файл 3D LUT» →
          .cube.
        </li>
        <li>
          <b>Lightroom, Camera Raw</b> — .cube напрямую не читают: создайте профиль в Camera Raw через Photoshop (Create
          Profile с Color Lookup), он появится в Lightroom.
        </li>
        <li>
          <b>darktable</b> — модуль «lut 3D», .cube или HaldCLUT, после filmic или sigmoid; пространство применения —
          sRGB.
        </li>
        <li>
          <b>DaVinci Resolve</b> — .cube в отдельном узле после перевода в Rec.709/sRGB. Интерполяция по умолчанию
          трилинейная — смотрите вторую строку проверки.
        </li>
        <li>
          <b>RawTherapee, G&apos;MIC</b> — HaldCLUT PNG.
        </li>
      </ul>
    </details>
  );
}

function Result({ dir, progress }: { dir: string; progress: ExportProgress | null }) {
  return (
    <div className="export-result" data-testid="export-result" data-dir={dir} data-finished={progress?.finished ? 'true' : 'false'}>
      <p>
        {progress?.finished
          ? progress.errors.length > 0
            ? 'Готово с ошибками'
            : 'Готово'
          : `Запись… ${progress?.done ?? 0} из ${progress?.total ?? '…'}`}
      </p>
      <p className="export-path" title={dir}>
        {dir}
      </p>
      {progress && progress.files.length > 0 && (
        <ul className="export-files">
          {progress.files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      )}
      {progress?.errors.map(({ file, message }) => (
        <p key={file} className="export-error">
          {file ? `${file}: ` : ''}
          {message}
        </p>
      ))}
    </div>
  );
}
