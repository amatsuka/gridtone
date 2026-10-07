import type { Project } from '@core/project/types';

/** 1 публикация, 2 публикации, 5 публикаций. */
function posts(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'публикация';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'публикации';
  return 'публикаций';
}

/**
 * Режим 1 «Профиль»: шапка-заглушка по образцу Instagram — аватар, имя, счётчики, вкладки.
 * Только чтобы сетка выглядела как в телефоне; данных профиля у приложения нет.
 */
export function ProfileHeader({ project }: { project: Project }) {
  const count = project.slots.filter((slot) => slot.assetId).length;
  return (
    <header className="profile-header" data-testid="profile-header">
      <div className="profile-top">
        <div className="profile-avatar" aria-hidden="true" />
        <div className="profile-stats">
          <div className="profile-name">{project.name}</div>
          <div className="profile-counters">
            <span>
              <b>{count}</b> {posts(count)}
            </span>
            <span>
              <b>—</b> подписчиков
            </span>
            <span>
              <b>—</b> подписок
            </span>
          </div>
        </div>
      </div>
      <div className="profile-tabs" aria-hidden="true">
        <span className="active">
          <svg viewBox="0 0 24 24">
            <path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
        </span>
        <span>
          <svg viewBox="0 0 24 24">
            <path d="M4 4h16v16H4zM10 9l5 3-5 3z" />
          </svg>
        </span>
        <span>
          <svg viewBox="0 0 24 24">
            <path d="M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c1-4 4-6 8-6s7 2 8 6" />
          </svg>
        </span>
      </div>
    </header>
  );
}
