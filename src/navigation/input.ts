import type { Context, Input, Intent } from './types.js';

export class InputError extends Error {}
export function record(raw: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('Expected an object');
  }
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new InputError('Expected a plain object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || (keys && !keys.includes(key))) throw new InputError('Unknown field');
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field || !('value' in field)) throw new InputError('Expected a data property');
    result[key] = field.value;
  }
  return result;
}
function text(raw: unknown, max: number, preserve = false): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) {
    throw new InputError(`Expected 1–${max} characters`);
  }
  return preserve ? raw : raw.trim();
}
function list<T>(raw: unknown, max: number, decode: (value: unknown) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > max) throw new InputError('Invalid array length');
  return Array.from(raw, decode);
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) throw new InputError('Duplicate value');
  return values;
}
export function normalizeInput(raw: unknown): Input {
  const p = record(raw, ['question', 'intent', 'seed_nodes', 'terms', 'context', 'mechanism']);
  const question = text(p.question, 1000);
  const intent: Intent = p.intent === 'layout' || p.intent === 'impact'
    || p.intent === 'decisions' || p.intent === 'family'
    ? p.intent : (() => { throw new InputError('Invalid intent'); })();
  const seed_nodes = unique(list(p.seed_nodes, 4, value => {
    const id = text(value, 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new InputError('Invalid node UUID');
    }
    return id;
  }));
  const terms = unique(list(p.terms, 4, value => text(value, 100)));
  const context = list<Context>(p.context, 12, value => {
    const item = record(value, ['label', 'text']);
    return { label: text(item.label, 160), text: text(item.text, 1600, true) };
  });
  unique(context.map(item => item.label));
  if (intent === 'family') {
    return { question, intent, seed_nodes, terms, context, mechanism: text(p.mechanism, 1000) };
  }
  if ('mechanism' in p) throw new InputError('mechanism requires family intent');
  return { question, intent, seed_nodes, terms, context };
}

