// План контента: подсказки из корзин, карточки в порядке публикации, пачки, Markdown и CSV (ADR 0026).
import { describe, expect, test } from 'vitest';
import { TEMPERATURE_AXIS, TINT_AXIS, temperature } from '@core/metrics/features';
import { labToSrgb8 } from '@core/metrics/tile';
import { generatePattern, DEFAULT_GENERATOR } from '@core/pattern/generator';
import { DEFAULT_LEVELS, hardTarget, levelL, softTarget, type Level } from '@core/pattern/levels';
import { makePattern, rotatePattern, targetLab, withPatternTargets } from '@core/pattern/pattern';
import {
  PLAN_CSV_COLUMNS,
  chromaWord,
  contentPlan,
  csvField,
  lightnessWord,
  markdownCell,
  planCsv,
  planMarkdown,
  swatchHex,
  targetHint,
  targetSwatch,
  targetTemperature,
  temperatureWord,
  type ContentPlan,
} from '@core/pattern/plan';
import { createProject, createSlot } from '@core/project/defaults';
import type { Pattern, Project, Slot, SlotTarget } from '@core/project/types';

const lvl = (level: Level) => hardTarget(levelL(level, DEFAULT_LEVELS));
const pattern = (levels: string): Pattern => makePattern('string', [...levels].map((c) => lvl(c as Level)));
/** Цель с цветом (a, b) — по точке плоскости, а не по тону: так проверяется именно ось температуры. */
const abTarget = (L: number, a: number, b: number): SlotTarget => {
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, hue: hue < 0 ? hue + 360 : hue, chroma: Math.hypot(a, b), tolerance: { L: 0.06, hue: 15, chroma: 0.02 }, hard: true };
};

describe('подсказка: корзины L, температуры и хромы', () => {
  test('L: тёмный < 0.53 ≤ средний < 0.71 ≤ светлый — уровни по умолчанию в своих корзинах', () => {
    expect([0, 0.5299, 0.53, 0.7099, 0.71, 1].map(lightnessWord)).toEqual(['тёмный', 'тёмный', 'средний', 'средний', 'светлый', 'светлый']);
    expect((['L', 'M', 'D'] as const).map((l) => lightnessWord(levelL(l, DEFAULT_LEVELS)))).toEqual(['светлый', 'средний', 'тёмный']);
  });

  test('температура: холодный < −0.01 ≤ нейтральный ≤ 0.01 < тёплый', () => {
    expect([-0.2, -0.0101, -0.01, 0, 0.01, 0.0101, 0.2].map(temperatureWord)).toEqual([
      'холодный',
      'холодный',
      'нейтральный',
      'нейтральный',
      'нейтральный',
      'тёплый',
      'тёплый',
    ]);
  });

  test('хрома: мало насыщенный < 0.04 ≤ умеренно насыщенный < 0.1 ≤ насыщенный', () => {
    expect([0, 0.0399, 0.04, 0.0999, 0.1, 0.3].map(chromaWord)).toEqual([
      'мало насыщенный',
      'мало насыщенный',
      'умеренно насыщенный',
      'умеренно насыщенный',
      'насыщенный',
      'насыщенный',
    ]);
  });

  test('температура цели — по оси температуры в базисе «температура, оттенок», как у плиток', () => {
    const [ua, ub] = TEMPERATURE_AXIS;
    const [va, vb] = TINT_AXIS;
    // Вдоль оси температуры — ровно сдвиг; оттенок температуру не меняет.
    expect(targetTemperature(abTarget(0.6, 0.0105 * ua, 0.0105 * ub))).toBeCloseTo(0.0105, 12);
    expect(targetHint(abTarget(0.6, 0.0105 * ua, 0.0105 * ub))).toBe('средний, тёплый, мало насыщенный');
    expect(targetHint(abTarget(0.6, 0.0095 * ua, 0.0095 * ub))).toBe('средний, нейтральный, мало насыщенный');
    // Сильный оттенок к пурпурному: b < 0, но температура та же — нейтральный, а не холодный.
    const tinted = abTarget(0.6, 0.005 * ua + 0.05 * va, 0.005 * ub + 0.05 * vb);
    expect(tinted.chroma! > 0.04 && Math.sin((tinted.hue! * Math.PI) / 180) < 0).toBe(true);
    expect(targetTemperature(tinted)).toBeCloseTo(0.005, 12);
    expect(targetHint(tinted)).toBe('средний, нейтральный, умеренно насыщенный');
    expect(targetTemperature(tinted)).toBeCloseTo(temperature(...(targetLab(tinted).slice(1) as [number, number])), 12);
  });

  test('цвета чередования по умолчанию: тёплый и холодный, умеренно насыщенные', () => {
    const p = generatePattern({ ...DEFAULT_GENERATOR, template: 'twoColors' }, DEFAULT_LEVELS);
    expect(p.cells.slice(0, 2).map((cell) => targetHint(cell))).toEqual([
      'средний, тёплый, умеренно насыщенный',
      'средний, холодный, умеренно насыщенный',
    ]);
    expect(targetHint(hardTarget(0.8, { hue: 70, chroma: 0.12 }))).toBe('светлый, тёплый, насыщенный');
  });

  test('у цели без цвета — «цвет любой»; без тона или без хромы — «любой» вместо своей части; без цели — «цели нет»', () => {
    expect(targetHint(lvl('L'))).toBe('светлый, цвет любой');
    expect(targetHint(softTarget(0.44))).toBe('тёмный, цвет любой');
    expect(targetHint({ L: 0.44, chroma: 0.02 })).toBe('тёмный, тон любой, мало насыщенный');
    expect(targetHint({ L: 0.8, hue: 70 })).toBe('светлый, тёплый, насыщенность любая');
    expect(targetTemperature({ L: 0.8, chroma: 0.05 })).toBeUndefined();
    expect(targetHint(undefined)).toBe('цели нет');
  });
});

describe('образец цели', () => {
  test('цвет — OKLab цели в sRGB 8 бит; без цвета — серый той же L', () => {
    const gray = targetSwatch(lvl('M'));
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
    expect(gray).toEqual(labToSrgb8([0.62, 0, 0]));
    const warm = hardTarget(0.62, { hue: 70, chroma: 0.06 });
    expect(targetSwatch(warm)).toEqual(labToSrgb8(targetLab(warm)));
    expect(targetSwatch(warm)[0]).toBeGreaterThan(targetSwatch(warm)[2]);
    expect(swatchHex([255, 0, 16])).toBe('#FF0010');
  });
});

const ASSETS = ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555'];

function photo(id: string, n: number, state: Slot['state'] = 'planned'): Slot {
  return { ...createSlot(id, ASSETS[n]), state };
}

/** Проект: слоты, закреплённые и паттерн; цели позиций — по паттерну, как после «Применить к сетке». */
function project(slots: Slot[], pinned: Project['grid']['pinned'] = 0, p?: Pattern, names: string[] = []): Project {
  const result = createProject('Лента');
  ASSETS.forEach((id, i) => {
    result.assets[id] = {
      id,
      path: `/фото/${names[i] ?? `кадр ${i + 1}`}.jpg`,
      hash: id.padEnd(64, '0'),
      w: 1080,
      h: 1440,
      format: 'jpeg',
      icc: 'embedded',
      importedAt: '2026-10-14T00:00:00.000Z',
    };
  });
  result.grid.pinned = pinned;
  result.slots = slots;
  if (p) {
    result.pattern = p;
    result.slots = withPatternTargets(slots, p, pinned);
  }
  return result;
}

const summary = (plan: ContentPlan) => plan.cards.map((c) => [c.number, c.index, c.photo, c.pin, c.belowPublished, c.batch]);

describe('карточки плана', () => {
  test('номера — planOrder: пустые с номером, опубликованные пропущены, закреплённые последними; цель — slot.target', () => {
    // Закреплённая с фото, две пустые, фото, опубликованный, два фото ниже него.
    const slots = [photo('p0', 0), createSlot('e1'), createSlot('e2'), photo('a3', 1), photo('b4', 2, 'published'), photo('c5', 3), photo('d6', 4)];
    const plan = contentPlan(project(slots, 1, pattern('LDLDLD')));
    expect(summary(plan)).toEqual([
      [1, 6, 'кадр 5.jpg', false, true, null],
      [2, 5, 'кадр 4.jpg', false, true, null],
      [3, 3, 'кадр 2.jpg', false, false, null],
      [4, 2, null, false, false, null],
      [5, 1, null, false, false, null],
      [6, 0, 'кадр 1.jpg', true, false, null],
    ]);
    // Цели — как в слотах: позиция 6 — L (клетка 0 периода), 5 — D; у закреплённой цели нет.
    expect(plan.cards.map((c) => c.target?.L ?? null)).toEqual([0.8, 0.44, 0.44, 0.8, 0.44, null]);
    expect(plan.cards.map((c) => c.hint)).toEqual([
      'светлый, цвет любой',
      'тёмный, цвет любой',
      'тёмный, цвет любой',
      'светлый, цвет любой',
      'тёмный, цвет любой',
      'цели нет',
    ]);
    expect(plan.cards[0]?.rgb).toEqual(targetSwatch(lvl('L')));
    expect(plan.cards[5]?.rgb).toBeNull();
    expect(plan.feed).toBe(5);
    expect(plan.pattern).toEqual({ source: 'string', periodRows: 2, postingMode: 'single' });
    expect(plan.warnings).toEqual(['Посты 1, 2 ниже опубликованного: на этих местах их не опубликовать.']);
  });

  test('цель берётся из слота как есть: после сдвига фазы — сдвинутые клетки; у закреплённой — нет, даже из файла', () => {
    const rotated = rotatePattern(pattern('LDLDLD'), 1);
    const p = project([photo('a', 0), photo('b', 1), createSlot('e')], 0, rotated);
    // Позиции 0, 1, 2 получили клетки D, L, D сдвинутого паттерна; карточки — снизу вверх.
    expect(contentPlan(p).cards.map((c) => [c.index, c.target?.L])).toEqual([
      [2, 0.44],
      [1, 0.8],
      [0, 0.44],
    ]);
    // Цель не пересчитывается из паттерна: что лежит в слоте, то и в плане.
    p.slots[2] = { ...p.slots[2]!, target: softTarget(0.3) };
    expect(contentPlan(p).cards[0]?.target).toEqual(softTarget(0.3));
    const manual = project([{ ...photo('a', 0), target: softTarget(0.3) }, { ...photo('b', 1), target: lvl('L') }], 1);
    const plan = contentPlan(manual);
    expect(plan.cards.map((c) => [c.index, c.target?.L ?? null, c.hint])).toEqual([
      [1, 0.8, 'светлый, цвет любой'],
      [0, null, 'цели нет'],
    ]);
    expect(plan.pattern).toBeNull();
    expect(plan.warnings).toEqual([]);
  });

  test('пустой план и план без целей', () => {
    expect(contentPlan(project([photo('a', 0, 'published')])).cards).toEqual([]);
    expect(contentPlan(project([])).warnings).toEqual([]);
    const plain = contentPlan(project([photo('a', 0), createSlot('e')]));
    expect(plain.cards.map((c) => c.hint)).toEqual(['цели нет', 'цели нет']);
    expect(plain.warnings).toEqual(['У позиций плана нет целей: примените паттерн к сетке.']);
  });

  test('пачками — карточки ленты по три по номерам, закреплённые вне пачек; неполная пачка — предупреждение', () => {
    const rows = makePattern('generator', [lvl('L'), lvl('L'), lvl('L'), lvl('D'), lvl('D'), lvl('D')]);
    expect(rows.postingMode).toBe('batch');
    const six = contentPlan(project(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => createSlot(id)), 0, rows));
    expect(six.cards.map((c) => c.batch)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(six.warnings).toEqual([]);
    const four = contentPlan(project([photo('p', 0), ...['a', 'b', 'c', 'd'].map((id) => createSlot(id))], 1, rows));
    expect(four.cards.map((c) => [c.number, c.batch, c.pin])).toEqual([
      [1, 1, false],
      [2, 1, false],
      [3, 1, false],
      [4, 2, false],
      [5, null, true],
    ]);
    expect(four.feed).toBe(4);
    expect(four.warnings).toEqual(['Позиций ленты в плане — 4, не кратно трём: последняя пачка неполная, лента сдвинется на неполный ряд.']);
    // Одиночные посты — без пачек и без предупреждения.
    const single = contentPlan(project(['a', 'b', 'c', 'd'].map((id) => createSlot(id)), 0, pattern('LDLDLD')));
    expect(single.cards.map((c) => c.batch)).toEqual([null, null, null, null]);
    expect(single.warnings).toEqual([]);
  });
});

/** Разбор CSV по RFC 4180 — для проверки, что файл читается обратно в те же поля. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) throw new Error('CSV не заканчивается переводом строки');
  return rows;
}

describe('Markdown и CSV', () => {
  const twoColors = generatePattern({ ...DEFAULT_GENERATOR, template: 'twoColors' }, DEFAULT_LEVELS);

  test('Markdown — заголовок, паттерн, порядок и таблица; закреплённая — «закрепить»', () => {
    const p = project([photo('p', 0), createSlot('e'), photo('a', 1, 'published'), photo('b', 2)], 1, twoColors);
    const plan = contentPlan(p);
    const [b, e] = [plan.cards[0]!, plan.cards[1]!];
    expect(planMarkdown(plan, 'Лента')).toBe(
      [
        '# План контента — Лента',
        '',
        'Паттерн: генератор, период 2 ряда · переживает одиночные посты.',
        '',
        'Порядок — снизу вверх: пост 1 — последняя позиция ленты, его публикуют первым; закреплённые — последними, их закрепляют.',
        '',
        '**Внимание:**',
        '',
        '- Пост 1 ниже опубликованного: на этом месте его не опубликовать.',
        '',
        '| № | Позиция | Фото | Цель | Цвет | Подсказка | Заметка |',
        '| ---: | --- | --- | --- | --- | --- | --- |',
        `| 1 | 4 · ряд 2, колонка 1 | кадр 3.jpg | L 0.62, тон 250°, хрома 0.060 | ${swatchHex(b.rgb!)} | средний, холодный, умеренно насыщенный | ниже опубликованного |`,
        `| 2 | 2 · ряд 1, колонка 2 | пусто | L 0.62, тон 250°, хрома 0.060 | ${swatchHex(e.rgb!)} | средний, холодный, умеренно насыщенный |  |`,
        '| 3 | 1 · ряд 1, колонка 1 | кадр 1.jpg | — | — | цели нет | закрепить |',
        '',
      ].join('\n'),
    );
  });

  test('Markdown пачками — колонка «Пачка»; мягкая цель помечена; без позиций — без таблицы', () => {
    const rows = makePattern('image', [softTarget(0.8), softTarget(0.8), softTarget(0.8)]);
    const plan = contentPlan(project([createSlot('e'), createSlot('f')], 0, makePattern('image', [...rows.cells, lvl('D'), lvl('D'), lvl('D')])));
    const md = planMarkdown(plan, 'Лента');
    expect(md).toContain('Паттерн: изображение, период 2 ряда · публиковать пачками по 3.');
    expect(md).toContain('| № | Пачка | Позиция | Фото | Цель | Цвет | Подсказка | Заметка |\n| ---: | ---: | --- |');
    expect(md).toContain('| 1 | 1 | 2 · ряд 1, колонка 2 | пусто | L 0.80, мягкая |');
    expect(md).toContain('- Позиций ленты в плане — 2, не кратно трём');
    const empty = planMarkdown(contentPlan(project([photo('a', 0, 'published')])), 'Лента');
    expect(empty).toBe(
      ['# План контента — Лента', '', 'Паттерна нет.', '', 'Позиций в плане нет: в сетке нет запланированных постов и пустых позиций.', ''].join('\n'),
    );
  });

  test('Markdown — спецсимволы и переводы строк в ячейках и заголовке экранируются', () => {
    expect(markdownCell('a | b')).toBe('a \\| b');
    expect(markdownCell('*кадр*_[1]\\')).toBe('\\*кадр\\*\\_\\[1\\]\\\\');
    expect(markdownCell('две\nстроки\r\nтри')).toBe('две строки три');
    expect(markdownCell('<b>`код`</b>')).toBe('\\<b\\>\\`код\\`\\</b\\>');
    const p = project([photo('a', 0)], 0, undefined, ['кадр | *1*\nутро']);
    const md = planMarkdown(contentPlan(p), 'Лента\n# не заголовок');
    expect(md.startsWith('# План контента — Лента \\# не заголовок\n')).toBe(true);
    expect(md).toContain('| кадр \\| \\*1\\* утро.jpg |');
  });

  test('CSV — RFC 4180: BOM, запятая, CRLF, точка в числах; кавычки, запятые и переводы строк в кавычках', () => {
    expect(csvField('просто')).toBe('просто');
    expect(csvField('a, b')).toBe('"a, b"');
    expect(csvField('кадр "2"')).toBe('"кадр ""2"""');
    expect(csvField('две\nстроки')).toBe('"две\nстроки"');
    expect(csvField('cr\r')).toBe('"cr\r"');
    expect(csvField(0.8)).toBe('0.8');

    const p = project([photo('p', 0), createSlot('e'), photo('a', 1, 'published'), photo('b', 2)], 1, twoColors, [
      'кадр 1',
      'кадр 2',
      'кадр "3", утро\nвторая строка',
    ]);
    const plan = contentPlan(p);
    const csv = planCsv(plan);
    expect(csv.startsWith('﻿Номер,Пачка,Позиция,')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(csv.slice(1));
    const [b, e] = [plan.cards[0]!, plan.cards[1]!];
    expect(rows).toEqual([
      [...PLAN_CSV_COLUMNS],
      ['1', '', '4', '2', '1', 'кадр "3", утро\nвторая строка.jpg', '', '0.620', '250', '0.060', 'жёсткая', swatchHex(b.rgb!), 'средний, холодный, умеренно насыщенный', 'ниже опубликованного'],
      ['2', '', '2', '1', '2', '', '', '0.620', '250', '0.060', 'жёсткая', swatchHex(e.rgb!), 'средний, холодный, умеренно насыщенный', ''],
      ['3', '', '1', '1', '1', 'кадр 1.jpg', 'да', '', '', '', '', '', 'цели нет', ''],
    ]);
    expect(PLAN_CSV_COLUMNS).toEqual(['Номер', 'Пачка', 'Позиция', 'Ряд', 'Колонка', 'Фото', 'Закрепить', 'L', 'Тон', 'Хрома', 'Цель', 'Цвет', 'Подсказка', 'Заметка']);
    // Перевод строки внутри поля — LF, как в имени; строки файла — CRLF.
    expect(csv).toContain('"кадр ""3"", утро\nвторая строка.jpg"');
  });

  test('CSV пачками — номер пачки; мягкая цель; тон 359.6° — 0', () => {
    const cells = [softTarget(0.8, { hue: 359.6, chroma: 0.05 }), lvl('L'), lvl('L'), lvl('D'), lvl('D'), lvl('D')];
    const plan = contentPlan(project([createSlot('e'), createSlot('f')], 0, makePattern('image', cells)));
    const rows = parseCsv(planCsv(plan).slice(1));
    expect(rows.slice(1).map((r) => [r[0], r[1], r[2], r[7], r[8], r[10]])).toEqual([
      ['1', '1', '2', '0.800', '', 'жёсткая'],
      ['2', '1', '1', '0.800', '0', 'мягкая'],
    ]);
  });
});
