// Анализ папки фото как сетки: npm run analyze -- <папка> [--ratio 1:1] [--json]
// Для калибровки порогов этапа 4 (ADR 0018–0020). Сам анализ — scripts/analyzeFolder.ts: он импортирует core
// через алиасы @core и @shared, поэтому загружается раннером Vite с теми же алиасами, что у сборки и тестов.
import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'Использование: npm run analyze -- <папка> [--ratio 3:4|1:1] [--json]';

const args = process.argv.slice(2);
const json = args.includes('--json');
const ratioAt = args.indexOf('--ratio');
const ratio = ratioAt >= 0 ? args[ratioAt + 1] : '3:4';
const dir = args.find((arg, i) => !arg.startsWith('--') && (ratioAt < 0 || i !== ratioAt + 1));
if (!dir || (ratio !== '3:4' && ratio !== '1:1')) {
  console.error(USAGE);
  process.exit(1);
}

type Analyzer = typeof import('./analyzeFolder.ts');
const { module } = await runnerImport<Analyzer>(resolve(ROOT, 'scripts/analyzeFolder.ts'), {
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  resolve: { alias: { '@core': resolve(ROOT, 'src/core'), '@shared': resolve(ROOT, 'shared') } },
});
const report = await module.analyzeFolder(resolve(dir), ratio);
if (report.tiles.length === 0) {
  console.error(`В папке ${report.dir} нет фото`);
  process.exit(1);
}
console.log(json ? JSON.stringify(report, null, 2) : module.formatReport(report));
