# 0002. Зависимости этапа 0

**Статус:** принято, 2026-10-06.

Все пакеты взяты из стека в спеке, кроме служебных @types.

| Пакет | Версия | Зачем |
| --- | --- | --- |
| sharp | ^0.35.5 | Декодирование, ICC → sRGB, прокси. Единственная runtime-зависимость: main и indexer загружают его из node_modules |
| electron | ^44.5.1 | Оболочка |
| electron-vite | ^5.0.0 | Сборка main, preload и renderer; `?modulePath` для utility process |
| vite | ^7.3.7 | electron-vite 5 поддерживает vite только до 7, поэтому не 8 |
| @vitejs/plugin-react | ^5.2.0 | Версия 6 требует vite 8 |
| react, react-dom | ^19.3.0 | Интерфейс |
| zustand | ^5.0.15 | Состояние renderer. Immer добавится вместе с undo/redo |
| typescript | ^7.0.2 | Только проверка типов: `tsc -p`, без эмита |
| vitest | ^5.0.3 | Модульные тесты |
| @playwright/test | ^1.63.0 | e2e через `_electron`, браузеры не скачиваются |
| @types/node, @types/react, @types/react-dom | — | Типы |

**Когда пересмотреть.** Когда выйдет стабильный electron-vite 6 с поддержкой vite 8 (сейчас 6.0.0-beta), можно поднять vite и plugin-react.
