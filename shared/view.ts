// Режимы просмотра сетки (docs/spec.md, «Режимы просмотра»; docs/decisions/0012-view-modes.md).
// Общие для меню «Вид» в main и переключателя в renderer. Режим — состояние интерфейса, в проект не пишется.

/** В порядке клавиш 1–7. */
export const VIEW_MODES = ['profile', 'grid', 'luminance', 'posterize', 'dominant', 'squint', 'deviation'] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

export const VIEW_MODE_LABELS: Readonly<Record<ViewMode, string>> = {
  profile: 'Профиль',
  grid: 'Рабочая сетка',
  luminance: 'Яркость',
  posterize: 'Постеризация',
  dominant: 'Доминанты',
  squint: 'Прищур',
  deviation: 'Отклонение',
};

export function isViewMode(value: unknown): value is ViewMode {
  return (VIEW_MODES as readonly unknown[]).includes(value);
}
