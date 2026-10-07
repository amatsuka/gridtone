import { useState } from 'react';
import { ADJUST_GROUP_IDS, type AdjustGroup } from '@core/project/adjustGroups';
import { closeGroupsDialog, copyAdjust, syncAdjust } from '../commands';
import { useAppStore } from '../store';

const GROUP_LABELS: Record<AdjustGroup, string> = {
  whiteBalance: 'Баланс белого',
  tone: 'Тон',
  presence: 'Присутствие',
  hsl: 'HSL',
  grading: 'Цветокоррекция',
  curves: 'Кривые',
};

const TEXT = {
  copy: { title: 'Копировать правки', hint: 'Какие группы взять с основной плитки.', confirm: 'Копировать' },
  sync: {
    title: 'Синхронизировать правки',
    hint: 'Какие группы перенести с основной плитки на остальные выделенные.',
    confirm: 'Применить',
  },
};

/** ⌘⇧C и «Синхронизировать…»: выбор групп правок, по умолчанию все. */
export function GroupsDialog() {
  const mode = useAppStore((state) => state.groupsDialog);
  // key: каждое открытие начинается со всех групп.
  return mode ? <GroupsForm key={mode} mode={mode} /> : null;
}

function GroupsForm({ mode }: { mode: 'copy' | 'sync' }) {
  const [groups, setGroups] = useState<ReadonlySet<AdjustGroup>>(() => new Set(ADJUST_GROUP_IDS));
  const text = TEXT[mode];
  const all = groups.size === ADJUST_GROUP_IDS.length;

  const toggle = (group: AdjustGroup) =>
    setGroups((current) => {
      const next = new Set(current);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  const confirm = () => {
    const chosen = ADJUST_GROUP_IDS.filter((group) => groups.has(group));
    closeGroupsDialog();
    if (mode === 'copy') copyAdjust(chosen);
    else syncAdjust(chosen);
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeGroupsDialog()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="groups-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          closeGroupsDialog();
        }}
      >
        <h2 id="groups-dialog-title">{text.title}</h2>
        <p className="muted">{text.hint}</p>
        {ADJUST_GROUP_IDS.map((group) => (
          <label key={group} className="check">
            <input type="checkbox" checked={groups.has(group)} onChange={() => toggle(group)} />
            {GROUP_LABELS[group]}
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" className="link" onClick={() => setGroups(new Set(all ? [] : ADJUST_GROUP_IDS))}>
            {all ? 'Снять все' : 'Выбрать все'}
          </button>
          <div className="spacer" />
          <button type="button" onClick={closeGroupsDialog}>
            Отмена
          </button>
          <button type="submit" className="primary" autoFocus disabled={groups.size === 0}>
            {text.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
