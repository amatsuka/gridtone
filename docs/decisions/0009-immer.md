# 0009. Immer

**Статус:** принято, 2026-10-07.

**Контекст.** Спека называет связку Zustand + Immer для undo/redo на патчах. На этапе 1 Immer нужен раньше, для потока правок (ADR 0008). Renderer меняет проект и получает список патчей, который уходит в main.

**Решение.** `immer` 11.1.21, в devDependencies, как react и zustand: renderer собирается Vite, и в рантайм-зависимости Electron он не попадает. Install-скриптов у пакета нет.

**Как используется.**
- Только в renderer: `produceWithPatches`, `applyPatches`, `enablePatches()` один раз при загрузке стора.
- core и main от Immer не зависят. Патчи в main применяет `applyProjectPatches` из core (`src/core/project/patch.ts`), который понимает тот же формат `{ op, path, value }`.
- Совпадение результата с самим Immer проверяет `tests/core/patch.test.ts`. Там Immer подключён как тестовая зависимость.

**Отвергнуто.**
- **Своя генерация патчей в renderer.** Пришлось бы вручную описывать каждую правку и обратную к ней для undo.
- **mutative** — быстрее Immer, но спека называет Immer. Выигрыш в скорости на проекте из десятков слотов не важен.
