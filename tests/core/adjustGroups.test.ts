import { describe, expect, test } from 'vitest';
import { ADJUST_GROUP_IDS, ADJUST_GROUPS, copyAdjustGroups } from '@core/project/adjustGroups';
import { createAdjust } from '@core/project/defaults';
import type { Adjust } from '@core/project/types';

function edited(): Adjust {
  const adjust = createAdjust();
  Object.assign(adjust, { exposure: 1.2, temp: -30, tint: 12, contrast: 25, shadows: 40, vibrance: 15, saturation: -10 });
  adjust.hsl.blue.sat = -100;
  adjust.grading.shadows = { hue: 220, amount: 30 };
  adjust.grading.balance = -20;
  adjust.curves.master = [
    [0, 0.05],
    [0.5, 0.55],
    [1, 1],
  ];
  return adjust;
}

describe('группы правок', () => {
  test('каждое поле коррекции ровно в одной группе', () => {
    const fields = ADJUST_GROUP_IDS.flatMap((group) => ADJUST_GROUPS[group]);
    expect(new Set(fields).size).toBe(fields.length);
    expect([...fields].sort()).toEqual(Object.keys(createAdjust()).sort());
  });

  test('копируются только выбранные группы', () => {
    const target = createAdjust();
    copyAdjustGroups(target, edited(), ['whiteBalance', 'hsl']);
    expect(target).toEqual({ ...createAdjust(), temp: -30, tint: 12, hsl: edited().hsl });
  });

  test('все группы — полная копия, ни одной — без изменений', () => {
    const all = createAdjust();
    copyAdjustGroups(all, edited(), ADJUST_GROUP_IDS);
    expect(all).toEqual(edited());

    const none = createAdjust();
    copyAdjustGroups(none, edited(), []);
    expect(none).toEqual(createAdjust());
  });

  test('копия не делит объекты с источником', () => {
    const source = edited();
    const target = createAdjust();
    copyAdjustGroups(target, source, ADJUST_GROUP_IDS);
    source.hsl.blue.sat = 50;
    source.grading.shadows.amount = 99;
    source.curves.master[1]![1] = 0.9;
    expect(target).toEqual(edited());
  });
});
