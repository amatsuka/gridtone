// Имена файлов и папок экспорта: из имён образов и проекта, одинаково на macOS и Windows.

const MAX_LENGTH = 100;
/** Запрещены в именах файлов Windows; «/» и «:» — ещё и на macOS. */
const FORBIDDEN = /[/\\:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]+/g;
/** Точки и пробелы по краям: имя с точкой в начале скрыто, с точкой в конце Windows обрезает. */
const EDGES = /^[\s.]+|[\s.]+$/g;

/** Имя файла без расширения. Если от имени ничего не осталось — fallback. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(CONTROL, ' ').replace(FORBIDDEN, '-').replace(EDGES, '');
  // По кодовым точкам: обрезка не разрежет суррогатную пару.
  const short = Array.from(cleaned).slice(0, MAX_LENGTH).join('').replace(EDGES, '');
  return short === '' ? fallback : short;
}

/** Повторы получают номер: «Плёнка», «Плёнка 2». Регистр не различается: на macOS и Windows это один файл. */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLocaleLowerCase()); n++) candidate = `${name} ${n}`;
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}

const pad = (v: number) => String(v).padStart(2, '0');

/** «<проект> — экспорт 2026-10-08 07-05-03», местное время. Двоеточий нет: Finder показал бы их как «/». */
export function exportFolderName(projectName: string, date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${safeFileName(projectName, 'Gridtone')} — экспорт ${day} ${time}`;
}
