// Анализ папки фото как сетки — для калибровки порогов этапа 4 на реальных лентах (`npm run analyze`).
// Фото по имени — позиции сетки, как при импорте; каждое читается тем же рецептом, что прокси 512
// (renderProxy из proxies.ts), окно по умолчанию, без правок. Дальше — те же tileMetrics и analyzeGrid, что
// у вкладки «Анализ»: признаки, ритм, гармония и выбросы (ADR 0018–0020).
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { formatPart, GRID_TOLERANCE } from '@core/harmony/outliers';
import { HARMONY_LABELS } from '@core/harmony/templates';
import { temperature } from '@core/metrics/features';
import { analyzeGrid, type GridAnalysis } from '@core/metrics/grid';
import { RHYTHM_LABELS, type TemplateFit } from '@core/metrics/rhythm';
import { tileMetrics, type TileMetrics } from '@core/metrics/tile';
import { createAdjust, createCrop, createSlot } from '@core/project/defaults';
import type { Project, Ratio } from '@core/project/types';
import { renderProxy } from '../src/indexer/proxies';
import { isImportable } from '../src/main/project/service';

export interface FolderTile {
  file: string;
  metrics: TileMetrics;
}

export interface FolderReport {
  dir: string;
  ratio: Ratio;
  tiles: FolderTile[];
  analysis: GridAnalysis;
}

/** Фото папки по имени (как импорт: с числами по значению), только форматы импорта. */
export async function folderPhotos(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => !name.startsWith('.') && isImportable(name));
  return names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((name) => join(dir, name));
}

/** Признаки фото так, как их считает воркер метрик: прокси 512 тем же рецептом, окно сетки, без правок. */
export async function photoMetrics(path: string, ratio: Ratio): Promise<TileMetrics> {
  const proxy = await renderProxy(path, 512);
  const { data, info } = await sharp(proxy).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  return tileMetrics(image, createCrop(), ratio, { photo: createAdjust() });
}

export async function analyzeFolder(dir: string, ratio: Ratio = '3:4'): Promise<FolderReport> {
  const files = await folderPhotos(dir);
  const tiles: FolderTile[] = [];
  for (const file of files) tiles.push({ file, metrics: await photoMetrics(file, ratio) });
  const project: Pick<Project, 'grid' | 'slots'> = {
    grid: { ratio, columns: 3, pinned: 0 },
    slots: tiles.map((_, i) => createSlot(`s${i}`, `photo${i}`)),
  };
  const bySlot = Object.fromEntries(tiles.map((tile, i) => [`s${i}`, tile.metrics]));
  return { dir, ratio, tiles, analysis: analyzeGrid(project, bySlot) };
}

const fixed = (value: number, digits = 2) => value.toFixed(digits);
const pad = (text: string, width: number) => text.padStart(width);

function fitText(fit: TemplateFit): string {
  const label = RHYTHM_LABELS[fit.template];
  return fit.template === 'gradient' && fit.slope !== undefined ? `${label} (${fit.slope >= 0 ? 'новые светлее' : 'новые темнее'})` : label;
}

/** Отчёт для человека: таблица признаков, метрики сетки, гармония и выбросы. */
export function formatReport({ dir, ratio, tiles, analysis }: FolderReport): string {
  const lines: string[] = [];
  lines.push(`Папка: ${dir}`);
  lines.push(`Сетка: ${tiles.length} фото, ${analysis.columns} × ${analysis.rows}, окно ${ratio}`);
  if (tiles.length === 0) return lines.join('\n');
  lines.push('');
  lines.push('  №  L     p05   p95   темп.   C̄      тон   C ср.  >0.8  <0.3  нейтр. плотн.  файл');
  tiles.forEach(({ file, metrics: m }, i) => {
    const T = temperature(m.meanA, m.meanB);
    lines.push(
      [
        pad(String(i + 1), 3),
        fixed(m.meanL),
        fixed(m.p05L),
        fixed(m.p95L),
        pad(fixed(T, 3), 7),
        fixed(m.meanC, 3),
        pad(`${Math.round(m.hue)}°`, 5),
        fixed(Math.hypot(m.meanA, m.meanB), 3),
        fixed(m.highKeyShare),
        fixed(m.lowKeyShare),
        pad(fixed(m.neutralShare), 6),
        pad(fixed(m.busyness, 3), 6),
        ` ${basename(file)}`,
      ].join('  '),
    );
  });
  lines.push('');

  const { metrics } = analysis;
  if (!metrics) {
    lines.push('Анализа сетки нет: нужно хотя бы 6 фото.');
    return lines.join('\n');
  }
  const { rhythm, harmony } = metrics;
  const rhythmText =
    rhythm.kind === 'flat'
      ? 'ровная'
      : `${rhythm.kind === 'pattern' ? fitText(rhythm.best) : `не распознан, ближе всего ${fitText(rhythm.best).toLowerCase()}`}, сила ${fixed(rhythm.best.strength)}`;
  lines.push(`Ритм: ${rhythmText}`);
  lines.push(`  все: ${rhythm.fits.map((fit) => `${fitText(fit)} ${fixed(fit.strength)}`).join(' · ')}`);
  lines.push(`Разброс L ${fixed(metrics.spread, 3)} · контраст соседей ↔ ${fmt(metrics.contrast.horizontal)} ↕ ${fmt(metrics.contrast.vertical)}`);
  if (harmony.kind === 'neutral') {
    lines.push(`Гармония: нейтральная сетка (средний вес ${fixed(harmony.meanWeight, 4)})`);
  } else {
    const outside = harmony.tiles.filter((t) => t.outside).length;
    const { best } = harmony;
    lines.push(
      `Гармония: ${best.template} — ${HARMONY_LABELS[best.template].toLowerCase()}${best.mirrored ? ' (зеркальный)' : ''}, ${fixed(best.angle, 1)}°, оценка ${fixed(best.score, 1)}°, вне шаблона ${outside}`,
    );
    lines.push(`  все: ${harmony.fits.map((fit) => `${fit.template} ${fixed(fit.score, 1)}° (цена ${fixed(fit.cost)})`).join(' · ')}`);
  }
  lines.push(`Палитра сетки: ${metrics.palette.map(({ lab, share }) => `L ${fixed(lab[0])} a ${fixed(lab[1], 3)} b ${fixed(lab[2], 3)} — ${Math.round(share * 100)}%`).join(' · ')}`);
  lines.push('');
  lines.push(
    `Допуски: L ${GRID_TOLERANCE.L} · температура ${GRID_TOLERANCE.temperature} · хрома ${GRID_TOLERANCE.chroma} · тон ${GRID_TOLERANCE.hue}° за краем сектора`,
  );
  if (analysis.outliers.length === 0) {
    lines.push('Выбросов нет.');
  } else {
    lines.push(`Выбросы (${analysis.outliers.length}):`);
    for (const outlier of analysis.outliers) {
      const reasons = outlier.reasons.map((part) => `${formatPart(part)} (${fixed(part.ratio, 1)})`).join(' · ');
      lines.push(`${pad(String(outlier.index + 1), 4)}  ${reasons}  — ${basename(tiles[outlier.index]?.file ?? '')}`);
    }
  }
  return lines.join('\n');
}

const fmt = (value: number | null) => (value === null ? '—' : fixed(value, 3));
