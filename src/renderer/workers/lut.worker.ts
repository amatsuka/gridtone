// Воркер проверки по кругу для диалога экспорта (docs/decisions/0014-lut-export.md): запекание 33³
// и, если 33 не проходит, 65³ — доли секунды на образ, но не в потоке интерфейса. Расчёт — chooseLutSize из core.
import type { Lut3D } from '@core/lut/lut3d';
import { chooseLutSize } from '@core/lut/verify';
import type { LutCheckMessage, LutCheckResponse } from './protocol';

/** LUT образов по id (ADR 0015): присылаются один раз, до первой проверки с ними. */
const luts = new Map<string, Lut3D>();

self.addEventListener('message', (event: MessageEvent<LutCheckMessage>) => {
  const message = event.data;
  if (message.type === 'lut') {
    luts.set(message.id, message.lut);
    return;
  }
  const { key, params, lutId } = message;
  let response: LutCheckResponse;
  try {
    const lut = lutId === undefined ? undefined : luts.get(lutId);
    if (lutId !== undefined && !lut) throw new Error(`LUT ${lutId} не прислан`);
    response = { key, ok: true, choice: chooseLutSize(lut ? { ...params, lut } : params) };
  } catch (err) {
    response = { key, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
});
