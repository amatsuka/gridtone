import { useEffect, useRef, useState } from 'react';
import { createAdjust } from '@core/project/defaults';
import { lookUsage } from '@core/project/looks';
import { lutRefOf } from '@core/project/luts';
import type { Look, Project, Slot } from '@core/project/types';
import { LOOK_NAME_MAX } from '@core/project/validate';
import {
  assignLookToSelection,
  detachLut,
  dismissLutImportError,
  duplicateLookById,
  editLookAdjust,
  editSlotAdjust,
  importLut,
  newLook,
  openGroupsDialog,
  removeLookById,
  renameLook,
  setActiveLook,
  setInspectorTab,
} from '../commands';
import { useLookLut } from '../luts';
import { plural } from '../plural';
import { useAppStore, type InspectorTab } from '../store';
import { AdjustPanel } from './AdjustPanel';
import { AnalysisPanel } from './AnalysisPanel';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'photo', label: 'Фото' },
  { id: 'look', label: 'Образ' },
  { id: 'analysis', label: 'Анализ' },
];

/**
 * Правая панель: поправка основной плитки и образы проекта (spec, «Коррекция в два уровня»),
 * анализ сетки (spec, модуль 3).
 */
export function Inspector() {
  const tab = useAppStore((state) => state.inspectorTab);
  const project = useAppStore((state) => state.snapshot?.project);
  const selection = useAppStore((state) => state.selection);
  const primary = project?.slots.find((slot) => slot.id === selection.primary);

  return (
    <aside className="inspector" data-testid="inspector">
      <div className="tabs" role="tablist">
        {TABS.map(({ id, label }) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setInspectorTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {project &&
        (tab === 'photo' ? (
          <PhotoTab slot={primary} selectedCount={selection.ids.length} />
        ) : tab === 'look' ? (
          <LookTab project={project} primary={primary} selectedIds={selection.ids} />
        ) : (
          <AnalysisPanel project={project} />
        ))}
    </aside>
  );
}

function PhotoTab({ slot, selectedCount }: { slot: Slot | undefined; selectedCount: number }) {
  if (!slot) return <p className="muted">Выберите плитку, чтобы править её цвет.</p>;
  // Опубликованные посты только участвуют в анализе (spec, «Статусы позиций»).
  const locked = slot.state === 'published' || !slot.assetId;

  return (
    <>
      <header className="inspector-header">
        <h2>Поправка фото</h2>
        <button className="link" disabled={locked} onClick={() => editSlotAdjust(slot.id, (a) => Object.assign(a, createAdjust()))}>
          Сбросить
        </button>
      </header>
      {selectedCount > 1 && (
        <div className="inspector-note">
          <span>
            Выделено {selectedCount} {plural(selectedCount, 'плитка', 'плитки', 'плиток')}. Ползунки правят основную.
          </span>
          <button onClick={() => openGroupsDialog('sync')}>Синхронизировать…</button>
        </div>
      )}
      {locked && <p className="muted">{slot.assetId ? 'Опубликованный пост не редактируется.' : 'В позиции нет фото.'}</p>}
      <AdjustPanel
        adjust={slot.adjust}
        disabled={locked}
        gesture={`slot:${slot.id}`}
        onEdit={(change, gesture) => editSlotAdjust(slot.id, change, gesture)}
      />
    </>
  );
}

function LookTab({ project, primary, selectedIds }: { project: Project; primary: Slot | undefined; selectedIds: readonly string[] }) {
  const activeLookId = useAppStore((state) => state.activeLookId);
  const importError = useAppStore((state) => state.lutImportError);
  const { looks } = project;
  const look = looks.find((l) => l.id === activeLookId) ?? looks[0];

  return (
    <>
      <header className="inspector-header">
        <h2>Образ</h2>
      </header>
      {look && (
        <select className="look-select" aria-label="Образ" value={look.id} onChange={(e) => setActiveLook(e.currentTarget.value)}>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {lookUsage(project, l.id)}
            </option>
          ))}
        </select>
      )}
      <div className="button-row">
        <button onClick={() => newLook(false)}>Новый образ</button>
        <button disabled={!primary?.assetId} onClick={() => newLook(true)} title="Образ с копией поправки основной плитки">
          Из поправки фото
        </button>
        <button onClick={() => void importLut()} title="Файл .cube станет новым образом: шаг 9 поверх коррекции образа">
          Импорт LUT…
        </button>
      </div>
      {importError && (
        <div className="inspector-note lut-import-error" role="alert" data-testid="lut-import-error">
          <span>LUT не импортирован. {importError}</span>
          <button className="link" onClick={dismissLutImportError}>
            Скрыть
          </button>
        </div>
      )}
      {look ? (
        <LookEditor look={look} project={project} selectedIds={selectedIds} />
      ) : (
        <p className="muted">Образов пока нет. Образ — общая обработка для группы плиток, она накладывается поверх поправки фото.</p>
      )}
    </>
  );
}

function LookEditor({ look, project, selectedIds }: { look: Look; project: Project; selectedIds: readonly string[] }) {
  const usage = lookUsage(project, look.id);
  const selected = new Set(selectedIds);
  const selectionHasLook = project.slots.some((slot) => selected.has(slot.id) && slot.lookId !== undefined);

  return (
    <>
      <label className="field">
        <span>Имя</span>
        <LookNameInput key={look.id} look={look} />
      </label>
      <p className="muted" data-testid="look-usage">
        {usage === 0 ? 'Не применён ни к одной плитке' : `Применён к ${usage} ${usage % 10 === 1 && usage % 100 !== 11 ? 'плитке' : 'плиткам'}`}
      </p>
      <div className="button-row">
        <button disabled={selectedIds.length === 0} onClick={() => assignLookToSelection(look.id)}>
          Назначить выделенным
        </button>
        <button disabled={!selectionHasLook} onClick={() => assignLookToSelection(null)}>
          Снять с выделенных
        </button>
      </div>
      <div className="button-row">
        <button onClick={() => duplicateLookById(look.id)}>Дублировать</button>
        <button onClick={() => removeLookById(look.id)}>Удалить</button>
      </div>
      <LookLutRow look={look} project={project} />
      <header className="inspector-header inspector-subheader">
        <h3>Коррекция образа</h3>
        <button className="link" onClick={() => editLookAdjust(look.id, (a) => Object.assign(a, createAdjust()))}>
          Сбросить
        </button>
      </header>
      <AdjustPanel
        adjust={look.adjust}
        disabled={false}
        gesture={`look:${look.id}`}
        onEdit={(change, gesture) => editLookAdjust(look.id, change, gesture)}
      />
    </>
  );
}

/** Импортированный LUT образа: имя файла и размер, «Снять LUT», предупреждение, если копия пропала (ADR 0015). */
function LookLutRow({ look, project }: { look: Look; project: Project }) {
  const ref = lutRefOf(project, look);
  const lut = useLookLut(look);
  if (!ref) return null;
  return (
    <div className="look-lut" data-testid="look-lut" data-state={lut.state}>
      <div className="look-lut-line">
        <span className="muted">LUT</span>
        <span className="look-lut-name" title={ref.name}>
          {ref.name}
        </span>
        <span className="muted">{ref.size}³</span>
        <button className="link" onClick={() => detachLut(look.id)}>
          Снять LUT
        </button>
      </div>
      <p className="muted">Применяется последним, поверх коррекции образа.</p>
      {lut.state === 'missing' && (
        <p className="export-error" role="alert">
          {lut.error} Пока его нет, LUT не применяется.
        </p>
      )}
    </div>
  );
}

/** Имя применяется при выходе из поля или по Enter; Esc и пустое имя возвращают прежнее. */
function LookNameInput({ look }: { look: Look }) {
  const [draft, setDraft] = useState(look.name);
  const cancelled = useRef(false);
  // Отмена и повтор переименования приходят снаружи.
  useEffect(() => setDraft(look.name), [look.name]);

  return (
    <input
      type="text"
      aria-label="Имя образа"
      value={draft}
      maxLength={LOOK_NAME_MAX}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(look.name);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelled.current || draft.trim() === '') setDraft(look.name);
        else renameLook(look.id, draft);
        cancelled.current = false;
      }}
    />
  );
}
