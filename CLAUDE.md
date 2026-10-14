# Gridtone

Десктоп-приложение для стилизации Instagram-сетки.
Спецификация: docs/spec.md. Статус и решения: docs/progress.md, docs/decisions/.

## Стек
Electron + electron-vite, TypeScript strict, React, Zustand + Immer, WebGL2,
sharp, better-sqlite3, Vitest, Playwright. Пакеты — npm.

## Команды
- npm run dev — запуск
- npm run typecheck — проверка типов: core, node (main/preload/indexer/tests), web
- npm test — Vitest
- npm run test:e2e — сборка + Playwright: критерии этапов и сверка шейдера с эталоном
- npm run build — сборка
- npm run fixtures -- <папка> [N] — синтетические фото для ручной проверки
- npm run analyze -- <папка> — признаки, ритм, гармония и выбросы папки фото как сетки (калибровка порогов)

## Правила
- Логика цвета, метрик, гармонии, подбора и LUT — только в src/core, без DOM и Node.
  Это проверяет tsconfig.core.json: импорт fs или обращение к document в core не скомпилируется.
- Конвейер цвета меняется синхронно в core/color/pipeline.ts и в шейдере;
  тест сравнения шейдера с эталоном обязан проходить (tests/e2e/shader-parity.spec.ts).
  Своих чисел в .glsl нет: константы и матрицы подставляет renderer/gl/program.ts из core.
- Новый алгоритм в core начинается с теста на синтетических данных.
- Все каналы IPC объявлены в shared/ipc.ts; renderer не трогает fs напрямую.
- Оригиналы фото никогда не перезаписываются.
- Проект меняется только через ProjectSession.update в main, иначе изменение не попадёт в автосохранение.
  Renderer правит проект только через editProject (store.ts): патчи уходят в main по project:patch (ADR 0008),
  main проверяет их по инвариантам (ADR 0010, 0022), отмена — на обратных патчах (ADR 0011);
  новое редактируемое поле слота добавляется в EDITABLE_SLOT_FIELDS в core/project/patch.ts и в validate.ts.
- Main добавляет слоты и образы только в конец: на этом держатся индексы в истории отмены (ADR 0011, 0015).
  Реестр `luts` меняет только main и только дописывает; renderer назначает образу лишь LUT из реестра.
  Renderer вставляет и удаляет только пустые позиции (ADR 0022), и только через assignSlots (core/project/slots.ts):
  replace изменившихся индексов и add/remove в хвосте, не замена массива. Фото в позицию ставит и убирает только main.
- Порядок публикации и номера постов — только planOrder (core/project/publish.ts): по нему нумеруют плитки и экспорт.
  Закреплённые (grid.pinned) не двигаются и в анализ не входят; опубликованные и пустые позиции не правятся —
  это проверяет patch.ts (ADR 0022).
- Прокси строятся только в src/indexer/proxies.ts; pipelineColourspace('srgb') там обязателен (ADR 0004).
  Картинки извне (возвращённая калибровочная карта, оригиналы для экспорта) читаются его же decodeSrgb (ADR 0016).
- Геометрия кадра — только core/project/crop.ts (ADR 0013): шейдер сетки, метрики и редактор фото берут окно оттуда.
  Без поворота окно обязано совпадать с этапом 1 бит в бит (tests/core/crop.test.ts).
- Режим просмотра — состояние интерфейса, в проект не пишется (ADR 0012). Метрики плиток считает
  core/metrics/tile.ts, воркер метрик только декодирует прокси: так e2e сверяет заливки с тем же кодом.
  Признаки плитки — tileFeatures (core/metrics/features.ts), анализ сетки — analyzeGrid (core/metrics/grid.ts),
  гармония — fitHarmony (core/harmony/templates.ts, ADR 0019) и выбросы — tileExpectations
  (core/harmony/outliers.ts, ADR 0020) внутри него; режим 7 и вкладка «Анализ» берут один расчёт
  (renderer/analysis.ts). Анализ — производные данные, в проект и историю не пишется (ADR 0018).
  Поправки выбросов — findFix (core/harmony/fixes.ts, ADR 0021): поиск одного ползунка через весь конвейер
  плитки; «Применить» — applyTileFix, одна правка editProject; «заменить» в проект не пишется.
- LUT запекается только через core/lut/bake.ts — узлы из applyBaked, без шейдера (ADR 0014).
  Экспорт пишет только в новую подпапку и с флагом wx: существующие файлы не перезаписываются.
- Посты и `Сетка.png` режутся из оригинала, сверенного по хэшу, по feedFrameTransform / gridWindowTransform;
  пиксели считает только core/image/render.ts с параметрами плитки — postPipeline (ADR 0017).
- Новая зависимость — только с записью в docs/decisions/. npm 12 блокирует install-скрипты:
  если пакету он нужен, разрешать осознанно через `npm install-scripts approve <pkg>`.
- В конце этапа обновить docs/progress.md: что сделано, решения, что дальше.
