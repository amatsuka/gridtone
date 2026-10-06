// Набор фото для ручной проверки: npm run fixtures -- <папка> [количество]
import { resolve } from 'node:path';
import { generateImportSet } from './generate.ts';

const [dir, count] = process.argv.slice(2);
if (!dir) {
  console.error('Использование: npm run fixtures -- <папка> [количество]');
  process.exit(1);
}
const files = await generateImportSet(resolve(dir), count ? Number(count) : 30);
console.log(`Готово: ${files.length} фото в ${resolve(dir)}`);
