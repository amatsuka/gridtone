// Образы для проверок LUT (этап 3а): общие для модульных тестов и e2e.
import { createAdjust } from '../../src/core/project/defaults';
import type { Adjust } from '../../src/core/project/types';

/** «Плёнка»: умеренные правки во всех группах — экспозиция, температура, контраст, кривая, HSL, круг теней. */
export function filmLook(): Adjust {
  const a = createAdjust();
  Object.assign(a, { exposure: 0.3, temp: 20, contrast: 30 });
  a.curves.master = [
    [0, 0.05],
    [0.5, 0.55],
    [1, 0.95],
  ];
  a.hsl.orange = { hue: -10, sat: 20, lum: 10 };
  a.grading.shadows = { hue: 200, amount: 40 };
  return a;
}

/** «Излом»: общая кривая с почти вертикальным участком на 10% входа — на 33 узлах проверка не проходит. */
export function kinkLook(): Adjust {
  const a = createAdjust();
  a.curves.master = [
    [0, 0],
    [0.45, 0.1],
    [0.55, 0.9],
    [1, 1],
  ];
  return a;
}
