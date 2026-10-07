// Проект — чистый JSON: копируется и сравнивается без учёта прототипов, Map и прочего.

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Глубокое равенство JSON-значений: у объектов совпадает и состав ключей. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  return sameJsonExcept(a, b, []);
}

/** Как sameJson для двух объектов, но поля skip не сравниваются и могут быть только у одного. */
export function sameJsonExcept(a: Record<string, unknown>, b: Record<string, unknown>, skip: readonly string[]): boolean {
  const keys = Object.keys(a).filter((key) => !skip.includes(key));
  const otherCount = Object.keys(b).filter((key) => !skip.includes(key)).length;
  return keys.length === otherCount && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
