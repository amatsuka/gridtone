// План контента (docs/spec.md, «Модуль 4. Паттерны», «Режим «План контента»»; docs/decisions/0026-content-plan.md).
// Карточка — на каждую запланированную и пустую позицию в порядке публикации (planOrder): номер, образец цели
// и словесная подсказка из корзин L, температуры и хромы. Цель берётся из слота как есть (slot.target —
// проекция паттерна, после «Переставить» со сдвигом фазы — сдвинутые клетки). У паттерна «пачками» карточки
// ленты сгруппированы по три. Здесь же тексты `План.md` и `План.csv`; пиксели `Цели.png` — targetGrid.ts.
// План — производные данные: в проект и историю не пишется.
import { temperature } from '../metrics/features';
import { labToSrgb8 } from '../metrics/tile';
import { plural } from '../plural';
import { fileName } from '../project/fileNames';
import { isPinnedIndex } from '../project/slots';
import { belowPublishedNote, planOrder } from '../project/publish';
import type { Pattern, Project, SlotTarget } from '../project/types';
import { PATTERN_COLUMNS, PATTERN_SOURCE_LABELS, POSTING_MODE_LABELS, targetLab } from './pattern';

/** Корзины L: тёмный < 0.53 ≤ средний < 0.71 ≤ светлый — середины между уровнями по умолчанию (0.44, 0.62, 0.80). */
export const L_MEDIUM_FROM = 0.53;
export const L_LIGHT_FROM = 0.71;
/** Температура цели: холодный < −0.01 ≤ нейтральный ≤ 0.01 < тёплый — как допуск температуры выбросов (ADR 0020). */
export const TEMPERATURE_NEUTRAL = 0.01;
/** Хрома: мало насыщенный < 0.04 ≤ умеренно насыщенный < 0.1 ≤ насыщенный. */
export const CHROMA_MODERATE_FROM = 0.04;
export const CHROMA_HIGH_FROM = 0.1;
/** Пачка — целый ряд ленты: сдвиг на три позиции равен сдвигу на ряд. */
export const BATCH_SIZE = PATTERN_COLUMNS;

/** Цвет sRGB 8 бит. */
export type Rgb8 = [number, number, number];

export function lightnessWord(L: number): string {
  return L < L_MEDIUM_FROM ? 'тёмный' : L < L_LIGHT_FROM ? 'средний' : 'светлый';
}

export function temperatureWord(t: number): string {
  return t < -TEMPERATURE_NEUTRAL ? 'холодный' : t > TEMPERATURE_NEUTRAL ? 'тёплый' : 'нейтральный';
}

export function chromaWord(C: number): string {
  return C < CHROMA_MODERATE_FROM ? 'мало насыщенный' : C < CHROMA_HIGH_FROM ? 'умеренно насыщенный' : 'насыщенный';
}

type TargetColour = Pick<SlotTarget, 'L' | 'hue' | 'chroma'>;

/**
 * Температура цвета цели — та же величина, что у плиток (`temperature`, ADR 0018): координата (a, b) вдоль оси
 * температуры в базисе «температура, оттенок». Без тона — undefined. Тон без хромы (только в ручном project.json) —
 * по направлению тона: важна сторона, а не величина.
 */
export function targetTemperature(target: TargetColour): number | undefined {
  if (target.hue === undefined) return undefined;
  const rad = (target.hue * Math.PI) / 180;
  const chroma = target.chroma ?? 1;
  return temperature(chroma * Math.cos(rad), chroma * Math.sin(rad));
}

/**
 * Подсказка: «средний, тёплый, умеренно насыщенный». У цели без цвета — «светлый, цвет любой»; без тона или без хромы —
 * «тон любой» или «насыщенность любая» вместо своей части. Без цели — «цели нет».
 */
export function targetHint(target: TargetColour | undefined): string {
  if (!target) return 'цели нет';
  const parts = [lightnessWord(target.L)];
  if (target.hue === undefined && target.chroma === undefined) return [...parts, 'цвет любой'].join(', ');
  const t = targetTemperature(target);
  parts.push(t === undefined ? 'тон любой' : temperatureWord(t));
  parts.push(target.chroma === undefined ? 'насыщенность любая' : chromaWord(target.chroma));
  return parts.join(', ');
}

/** Образец цели: OKLab цели со срезом в охват sRGB, 8 бит; без цвета — серый той же L. Им же залиты плитки `Цели.png`. */
export function targetSwatch(target: TargetColour): Rgb8 {
  return labToSrgb8(targetLab(target));
}

/** «#D8C39A». */
export function swatchHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/** Карточка плана: запланированный пост или пустая позиция. */
export interface PlanCard {
  /** Номер в порядке публикации (planOrder), с 1. */
  number: number;
  /** Позиция в сетке. */
  index: number;
  slotId: string;
  /** Имя файла оригинала; null — пустая позиция: сюда нужен пост. */
  photo: string | null;
  /** Закреплённая: публикуется последней и закрепляется; цели у неё нет. */
  pin: boolean;
  /** Ниже опубликованного: на этом месте пост не опубликовать. */
  belowPublished: boolean;
  /** Цель позиции как есть (slot.target); у закреплённой — null. */
  target: SlotTarget | null;
  /** Образец цели; null — цели нет. */
  rgb: Rgb8 | null;
  hint: string;
  /** Номер пачки по три у паттерна «пачками»; у одиночных и у закреплённых — null. */
  batch: number | null;
}

export interface ContentPlan {
  cards: PlanCard[];
  /** Паттерн сетки: источник, период, режим публикации; null — паттерна нет. */
  pattern: Pick<Pattern, 'source' | 'periodRows' | 'postingMode'> | null;
  /** Карточек ленты — без закреплённых. */
  feed: number;
  /** Предупреждения: пост ниже опубликованного, неполная пачка, целей нет. */
  warnings: string[];
}

/** План контента проекта. */
export function contentPlan(project: Pick<Project, 'slots' | 'grid' | 'pattern' | 'assets'>): ContentPlan {
  const { slots, pattern, assets } = project;
  const pinned = project.grid.pinned;
  const entries = planOrder(slots, pinned);
  const batches = pattern?.postingMode === 'batch';
  const cards = entries.map((entry): PlanCard => {
    const slot = slots[entry.index] as Project['slots'][number];
    // Закреплённая вне паттерна и анализа (ADR 0022): цель из файла у неё не учитывается.
    const target = isPinnedIndex(entry.index, pinned) ? null : (slot.target ?? null);
    const asset = slot.assetId === undefined ? undefined : assets[slot.assetId];
    return {
      number: entry.number,
      index: entry.index,
      slotId: entry.slotId,
      photo: entry.photo ? (asset ? fileName(asset.path) : (slot.assetId as string)) : null,
      pin: entry.pin,
      belowPublished: entry.belowPublished,
      target,
      rgb: target ? targetSwatch(target) : null,
      hint: targetHint(target ?? undefined),
      // Лента идёт первой, её номера — 1…feed: пачка — каждые три номера.
      batch: batches && !entry.pin ? Math.ceil(entry.number / BATCH_SIZE) : null,
    };
  });
  const feed = cards.filter((card) => !card.pin).length;
  const warnings: string[] = [];
  const below = belowPublishedNote(entries);
  if (below) warnings.push(below);
  if (batches && feed % BATCH_SIZE !== 0) {
    warnings.push(`Позиций ленты в плане — ${feed}, не кратно трём: последняя пачка неполная, лента сдвинется на неполный ряд.`);
  }
  if (cards.length > 0 && cards.every((card) => card.target === null)) {
    warnings.push('У позиций плана нет целей: примените паттерн к сетке.');
  }
  return {
    cards,
    pattern: pattern ? { source: pattern.source, periodRows: pattern.periodRows, postingMode: pattern.postingMode } : null,
    feed,
    warnings,
  };
}

/** «ряд 2, колонка 3» — место позиции в сетке. */
function place(index: number): { row: number; column: number } {
  return { row: Math.floor(index / PATTERN_COLUMNS) + 1, column: (index % PATTERN_COLUMNS) + 1 };
}

/** «L 0.62, тон 250°, хрома 0.060» и «, мягкая» у цели, снятой с фото. */
export function targetText(target: SlotTarget): string {
  const parts = [`L ${target.L.toFixed(2)}`];
  if (target.hue !== undefined) parts.push(`тон ${roundHue(target.hue)}°`);
  if (target.chroma !== undefined) parts.push(`хрома ${target.chroma.toFixed(3)}`);
  if (!target.hard) parts.push('мягкая');
  return parts.join(', ');
}

/** Тон целыми градусами 0…359: 359.6° — 0°. */
function roundHue(hue: number): number {
  return Math.round(hue) % 360;
}

/** Заметки карточки для таблиц: «закрепить» (в CSV у него своя колонка), «ниже опубликованного». */
function cardNotes(card: PlanCard, pin: boolean): string {
  return [pin && card.pin ? 'закрепить' : '', card.belowPublished ? 'ниже опубликованного' : ''].filter(Boolean).join('; ');
}

/** Ячейка таблицы Markdown: переводы строк — пробелом, «|» и разметка CommonMark — с обратной косой чертой. */
export function markdownCell(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/g, '\\$&').replace(/\r\n|\r|\n/g, ' ');
}

function patternLine(plan: ContentPlan): string {
  const { pattern } = plan;
  if (!pattern) return 'Паттерна нет.';
  const rows = `${pattern.periodRows} ${plural(pattern.periodRows, 'ряд', 'ряда', 'рядов')}`;
  return `Паттерн: ${PATTERN_SOURCE_LABELS[pattern.source]}, период ${rows} · ${POSTING_MODE_LABELS[pattern.postingMode].toLowerCase()}.`;
}

/**
 * `План.md`: заголовок с именем проекта, паттерн и режим публикации, порядок, предупреждения и таблица карточек.
 * Колонка «Пачка» — только у паттерна «пачками». Строки — LF, в конце перевод строки.
 */
export function planMarkdown(plan: ContentPlan, projectName: string): string {
  const lines = [`# План контента — ${markdownCell(projectName)}`, '', patternLine(plan), ''];
  if (plan.cards.length === 0) {
    lines.push('Позиций в плане нет: в сетке нет запланированных постов и пустых позиций.', '');
    return lines.join('\n');
  }
  lines.push(
    'Порядок — снизу вверх: пост 1 — последняя позиция ленты, его публикуют первым; закреплённые — последними, их закрепляют.',
    '',
  );
  if (plan.warnings.length > 0) lines.push('**Внимание:**', '', ...plan.warnings.map((w) => `- ${markdownCell(w)}`), '');
  const batches = plan.pattern?.postingMode === 'batch';
  const header = ['№', ...(batches ? ['Пачка'] : []), 'Позиция', 'Фото', 'Цель', 'Цвет', 'Подсказка', 'Заметка'];
  const align = ['---:', ...(batches ? ['---:'] : []), ...Array<string>(6).fill('---')];
  const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  lines.push(row(header), row(align));
  for (const card of plan.cards) {
    const { row: r, column } = place(card.index);
    lines.push(
      row([
        String(card.number),
        ...(batches ? [card.batch === null ? '' : String(card.batch)] : []),
        `${card.index + 1} · ряд ${r}, колонка ${column}`,
        card.photo === null ? 'пусто' : markdownCell(card.photo),
        card.target ? targetText(card.target) : '—',
        card.rgb ? swatchHex(card.rgb) : '—',
        markdownCell(card.hint),
        cardNotes(card, true),
      ]),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Колонки `План.csv`. */
export const PLAN_CSV_COLUMNS = [
  'Номер',
  'Пачка',
  'Позиция',
  'Ряд',
  'Колонка',
  'Фото',
  'Закрепить',
  'L',
  'Тон',
  'Хрома',
  'Цель',
  'Цвет',
  'Подсказка',
  'Заметка',
] as const;

/** Поле CSV по RFC 4180: с кавычкой, запятой или переводом строки — в кавычках, кавычка удваивается. */
export function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * `План.csv` — RFC 4180: запятая, строки CRLF, UTF-8 с BOM (иначе Excel откроет кириллицу не в той кодировке),
 * точка в числах. L и хрома — 3 знака, тон — целые градусы; пустое поле — величины нет.
 */
export function planCsv(plan: ContentPlan): string {
  const rows = plan.cards.map((card) => {
    const { row, column } = place(card.index);
    const { target } = card;
    return [
      card.number,
      card.batch ?? '',
      card.index + 1,
      row,
      column,
      card.photo ?? '',
      card.pin ? 'да' : '',
      target ? target.L.toFixed(3) : '',
      target?.hue === undefined ? '' : roundHue(target.hue),
      target?.chroma === undefined ? '' : target.chroma.toFixed(3),
      target ? (target.hard ? 'жёсткая' : 'мягкая') : '',
      card.rgb ? swatchHex(card.rgb) : '',
      card.hint,
      cardNotes(card, false),
    ];
  });
  return `﻿${[[...PLAN_CSV_COLUMNS], ...rows].map((fields) => `${fields.map(csvField).join(',')}\r\n`).join('')}`;
}
