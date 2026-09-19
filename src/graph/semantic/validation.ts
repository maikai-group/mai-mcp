export class SemanticError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SemanticError('Expected an object');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key)) throw new SemanticError(`Unknown field: ${key}`);
    result[key] = value;
  }
  return result;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new SemanticError(`Expected text containing 1–${max} characters`);
  }
  return value.trim();
}
export function integer(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SemanticError(`Expected integer ${min}–${max}`);
  }
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new SemanticError('Expected canonical UUID');
  }
  return value;
}
