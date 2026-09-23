import type { ApiProvider } from '../../providers/types.js';

const ENV_KEYS: Record<ApiProvider, string> = {
  typesafe: 'TYPESAFE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
};

function environmentCredential(provider: ApiProvider): string | null {
  const value = process.env[ENV_KEYS[provider]];
  if (value === undefined) return null;
  return value.trim() || null;
}

export function routingSnapshot() {
  return { summary: null, brain: null, revision: 0 };
}

export function credentialConfigured(provider: ApiProvider): boolean {
  return environmentCredential(provider) !== null;
}

export async function resolveCredential(provider: ApiProvider): Promise<string | null> {
  return environmentCredential(provider);
}

export function credentialRevision(provider: ApiProvider): string {
  return process.env[ENV_KEYS[provider]] === undefined ? 'missing' : 'environment';
}
