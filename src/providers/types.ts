export type ApiProvider = 'typesafe' | 'anthropic' | 'openai' | 'voyage';
export type CredentialSource = 'environment' | 'saved' | 'missing';
export type CheckState = 'unchecked' | 'valid' | 'rejected' | 'inconclusive';
export type SummaryProvider = 'anthropic' | 'openai' | 'claude-code' | 'codex-cli';
export interface SummaryRoute {
  enabled: boolean; provider: SummaryProvider; model: string | null;
  fallback: 'claude-code' | 'codex-cli' | null;
}
export interface BrainRoute { enabled: boolean; provider: 'local' | 'openai' | 'voyage' }
export interface JevPolicy { enabled: boolean; model: string }
export interface CheckResult {
  state: CheckState; checkedAt: string; operation: 'auth' | 'embedding' | 'evaluation';
  credentialRevision: number | null; reason: 'accepted' | 'rejected' | 'network' | 'rate_limit'
    | 'provider_error' | 'unavailable' | 'invalid_response' | 'configuration_changed';
}
export interface CredentialMetadata {
  provider: ApiProvider; saved: boolean; configured: boolean; revision: number; source: CredentialSource;
  check: CheckResult | null;
}
export interface StoredState {
  revision: number; credentials: CredentialMetadata[];
  summary: SummaryRoute | null; brain: BrainRoute | null;
  jev: Record<string, JevPolicy>;
}
export class ProviderConfigError extends Error {
  constructor(readonly code: 'invalid_input' | 'conflict' | 'store_unavailable'
    | 'recovery_required' | 'cancelled' | 'unauthorized' | 'local_only') { super(code); }
}
export interface Ciphertext { iv: Buffer; tag: Buffer; ciphertext: Buffer }

export const API_PROVIDERS: readonly ApiProvider[] = ['typesafe', 'anthropic', 'openai', 'voyage'];
export function isProvider(value: unknown): value is ApiProvider {
  return value === 'typesafe' || value === 'anthropic' || value === 'openai' || value === 'voyage';
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function isModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
}
export function isSummaryRoute(value: unknown): value is SummaryRoute {
  return isRecord(value) && exactKeys(value, ['enabled', 'provider', 'model', 'fallback'])
    && typeof value.enabled === 'boolean'
    && typeof value.provider === 'string' && ['anthropic', 'openai', 'claude-code', 'codex-cli'].includes(value.provider)
    && (value.model === null || isModel(value.model))
    && (value.fallback === null || value.fallback === 'claude-code' || value.fallback === 'codex-cli');
}
export function isBrainRoute(value: unknown): value is BrainRoute {
  return isRecord(value) && exactKeys(value, ['enabled', 'provider']) && typeof value.enabled === 'boolean'
    && (value.provider === 'local' || value.provider === 'openai' || value.provider === 'voyage');
}
export function isJevPolicy(value: unknown): value is JevPolicy {
  return isRecord(value) && exactKeys(value, ['enabled', 'model']) && typeof value.enabled === 'boolean' && isModel(value.model);
}
export function isCheckResult(value: unknown): value is CheckResult {
  return isRecord(value) && exactKeys(value, ['state', 'checkedAt', 'operation', 'credentialRevision', 'reason'])
    && typeof value.state === 'string' && ['unchecked', 'valid', 'rejected', 'inconclusive'].includes(value.state)
    && typeof value.checkedAt === 'string' && value.checkedAt.length <= 32 && Number.isFinite(Date.parse(value.checkedAt))
    && typeof value.operation === 'string' && ['auth', 'embedding', 'evaluation'].includes(value.operation)
    && (value.credentialRevision === null || (isRevision(value.credentialRevision) && value.credentialRevision > 0))
    && typeof value.reason === 'string' && ['accepted', 'rejected', 'network', 'rate_limit', 'provider_error', 'unavailable', 'invalid_response', 'configuration_changed'].includes(value.reason);
}
export function validateKey(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderConfigError('invalid_input');
  const key = value.trim();
  if (!/^[\x21-\x7e]{1,8192}$/.test(key)) throw new ProviderConfigError('invalid_input');
  return key;
}

export interface NativeStatus {
  claude: 'installed_auth_unverified' | 'unavailable';
  codex: 'authenticated' | 'unauthenticated' | 'unavailable';
}
export interface ProviderStatus {
  revision:number; storage:'available'|'unconfigured'|'unavailable'; credentials:CredentialMetadata[];
  routing:{savedSummary:SummaryRoute|null;savedBrain:BrainRoute|null;activeSummary:SummaryRoute|null;activeBrain:BrainRoute|null;restartRequired:boolean;managed:{summary:string[];brain:string[]}};
  jev:{projectId:string;policy:JevPolicy;managed:string[]}|null;
  native?:NativeStatus;
}
