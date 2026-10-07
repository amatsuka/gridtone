// Воркер проверки по кругу для диалога экспорта (docs/decisions/0014-lut-export.md): запекание 33³
// и, если 33 не проходит, 65³ — доли секунды на образ, но не в потоке интерфейса. Расчёт — chooseLutSize из core.
import { chooseLutSize } from '@core/lut/verify';
import type { LutCheckRequest, LutCheckResponse } from './protocol';

self.addEventListener('message', (event: MessageEvent<LutCheckRequest>) => {
  const { key, params } = event.data;
  let response: LutCheckResponse;
  try {
    response = { key, ok: true, choice: chooseLutSize(params) };
  } catch (err) {
    response = { key, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
});
