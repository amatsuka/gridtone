import { useEffect, useRef, useState } from 'react';
import { createAdjust } from '@core/project/defaults';
import { lookUsage } from '@core/project/looks';
import type { Look, Project, Slot } from '@core/project/types';
import { LOOK_NAME_MAX } from '@core/project/validate';
import {
  assignLookToSelection,
  duplicateLookById,
  editLookAdjust,
  editSlotAdjust,
  newLook,
  openGroupsDialog,
  removeLookById,
  renameLook,
  setActiveLook,
  setInspectorTab,
} from '../commands';
import { useAppStore, type InspectorTab } from '../store';
import { AdjustPanel } from './AdjustPanel';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'photo', label: 'Фото' },
  { id: 'look', label: 'Образ' },
];

/** Правая панель: поправка основной плитки и образы проекта (spec, «Коррекция в два уровня»). */
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
        ) : (
          <LookTab project={project} primary={primary} selectedIds={selection.ids} />
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
      </div>
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

/** 1 плитка, 2 плитки, 5 плиток. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
