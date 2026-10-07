// Проверка по кругу для диалога экспорта: результат по образу, считает воркер (docs/decisions/0014-lut-export.md).
// Ключ — коррекция образа: правка образа даёт новую проверку, прежние результаты остаются в кэше.
import { create } from 'zustand';
import { lookPipeline } from '@core/lut/bake';
import type { LutSizeChoice } from '@core/lut/verify';
import type { Adjust } from '@core/project/types';
import type { LutCheckRequest, LutCheckResponse } from './workers/protocol';

/** Результатов в кэше: по несколько сотен байт. */
const CACHE_LIMIT = 100;

export type LutCheckResult = { ok: true; choice: LutSizeChoice } | { ok: false; error: string };

interface LutCheckState {
  byKey: Readonly<Record<string, LutCheckResult>>;
}

export const useLutChecks = create<LutCheckState>()(() => ({ byKey: {} }));

let worker: Worker | null = null;
const pending = new Set<string>();

export function lutCheckKey(adjust: Adjust): string {
  return JSON.stringify(adjust);
}

function onMessage(event: MessageEvent<LutCheckResponse>): void {
  const { key, ...result } = event.data;
  pending.delete(key);
  const byKey = { ...useLutChecks.getState().byKey, [key]: result };
  const keys = Object.keys(byKey);
  for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) delete byKey[old];
  useLutChecks.setState({ byKey });
}

/** Ставит образ в очередь проверки, если результата ещё нет. Возвращает ключ результата. */
export function requestLutCheck(adjust: Adjust): string {
  const key = lutCheckKey(adjust);
  if (useLutChecks.getState().byKey[key] || pending.has(key)) return key;
  pending.add(key);
  if (!worker) {
    worker = new Worker(new URL('./workers/lut.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (event) => {
      console.error('Воркер проверки LUT упал', event.message);
      // Ждущие проверки иначе висели бы в «Проверка…» до перезапуска.
      worker?.terminate();
      worker = null;
      for (const lost of [...pending]) onMessage(new MessageEvent('message', { data: { key: lost, ok: false, error: event.message } }));
    });
  }
  const request: LutCheckRequest = { key, params: lookPipeline(adjust) };
  worker.postMessage(request);
  return key;
}
