// Pure, privacy-bounded service-contract identities and normalizers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPhysicalPath } from './roots.js';

export type HttpMethod =
  | 'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ServiceIdentity {
  id: string;
  aliases: string[];
}

export interface HttpCallMetadata {
  contract: 'http-call-v1';
  source_service: string;
  target_host: string;
  method: HttpMethod;
  path: string;
}

export interface EndpointMetadata {
  contract: 'http-endpoint-v1';
  service_id: string;
  service_aliases: string[];
  method: HttpMethod;
  path: string;
}

export const SERVICE_IDENTITY_BASENAMES = new Set([
  'package.json', 'composer.json', 'pyproject.toml',
]);

export const SERVICE_QUALIFIED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.php', '.py',
]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const METHODS: readonly HttpMethod[] = [
  'ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedRead(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function normalizeServiceAlias(value: string): string | null {
  if (CONTROL.test(value)) return null;
  const normalized = value.toLowerCase().match(/[a-z0-9]+/g)?.join('-') ?? '';
  return normalized || null;
}

function jsonManifestAlias(filePath: string, key: 'package' | 'composer'): string | null {
  const raw = boundedRead(filePath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string') return null;
  const name = parsed.name.split('/').at(-1) ?? '';
  return normalizeServiceAlias(name);
}

function pyprojectAlias(filePath: string): string | null {
  const raw = boundedRead(filePath);
  if (raw === null) return null;
  let inProject = false;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (header) {
      inProject = header[1].trim() === 'project';
      continue;
    }
    if (!inProject) continue;
    const name = line.match(/^\s*name\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?$/);
    if (name) return normalizeServiceAlias(name[2]);
  }
  return null;
}

export function serviceIdentity(repoRoot: string): ServiceIdentity {
  if (!path.isAbsolute(repoRoot)) throw new Error(`Service root must be absolute: ${repoRoot}`);
  const physical = canonicalPhysicalPath(repoRoot, process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(physical);
  } catch {
    throw new Error(`Service root is missing: ${repoRoot}`);
  }
  if (!stat.isDirectory()) throw new Error(`Service root is not a directory: ${repoRoot}`);
  const basename = normalizeServiceAlias(path.basename(physical));
  const aliases = new Set<string>();
  if (basename !== null) aliases.add(basename);
  const packageAlias = jsonManifestAlias(path.join(physical, 'package.json'), 'package');
  const composerAlias = jsonManifestAlias(path.join(physical, 'composer.json'), 'composer');
  const pythonAlias = pyprojectAlias(path.join(physical, 'pyproject.toml'));
  for (const alias of [packageAlias, composerAlias, pythonAlias]) if (alias !== null) aliases.add(alias);
  const prefix = basename ?? 'service';
  const digest = crypto.createHash('sha256').update(physical).digest('hex').slice(0, 12);
  return { id: `${prefix}-${digest}`, aliases: [...aliases].sort() };
}

export function normalizeHttpMethod(value: string | undefined): HttpMethod | null {
  if (value === undefined || CONTROL.test(value)) return null;
  const normalized = value.trim().toUpperCase();
  return METHODS.find((method) => method === normalized) ?? null;
}

function normalizeRouteSegment(segment: string): string | null {
  if (segment === '{}' || segment === '{**}') return segment;
  if (/^:[^/]+$/.test(segment)) return '{}';
  if (/^\{[^/{}]+}$/.test(segment)) return '{}';
  if (/^\[[^/.][^/]*]$/.test(segment)) return '{}';
  if (/^\[\.\.\.[^/]+]$/.test(segment)) return '{**}';
  const flask = segment.match(/^<([^>]+)>$/);
  if (flask) {
    const inner = flask[1];
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return '{}';
    if (/^(?:string|int|float|uuid):[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return '{}';
    if (/^any\([^<>]*\):[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return '{}';
    if (/^path:[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return '{**}';
    return null;
  }
  return segment;
}

export function normalizeRoutePath(value: string): string | null {
  if (CONTROL.test(value)) return null;
  const withoutSuffix = value.split(/[?#]/, 1)[0];
  const rawSegments = withoutSuffix.split('/').filter(Boolean);
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const segment = normalizeRouteSegment(raw);
    if (segment === null) return null;
    segments.push(segment);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function parseLiteralHttpUrl(value: string): { host: string; methodPath: string } | null {
  if (CONTROL.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  const methodPath = normalizeRoutePath(parsed.pathname);
  return methodPath === null ? null : { host: parsed.hostname.toLowerCase(), methodPath };
}

function routeSegments(route: string): string[] {
  return route === '/' ? [] : route.slice(1).split('/');
}

export function routeMatches(provider: string, caller: string): boolean {
  const normalizedProvider = normalizeRoutePath(provider);
  const normalizedCaller = normalizeRoutePath(caller);
  if (normalizedProvider === null || normalizedCaller === null) return false;
  const expected = routeSegments(normalizedProvider);
  const actual = routeSegments(normalizedCaller);
  const walk = (expectedIndex: number, actualIndex: number): boolean => {
    if (expectedIndex === expected.length) return actualIndex === actual.length;
    const segment = expected[expectedIndex];
    if (segment === '{**}') {
      for (let next = actualIndex + 1; next <= actual.length; next++) {
        if (walk(expectedIndex + 1, next)) return true;
      }
      return false;
    }
    if (actualIndex >= actual.length) return false;
    if (segment !== '{}' && segment !== actual[actualIndex]) return false;
    return walk(expectedIndex + 1, actualIndex + 1);
  };
  return walk(0, 0);
}

export function serviceSourceQName(serviceId: string, legacyQName: string): string {
  const prefix = `service-source:${serviceId}:`;
  return legacyQName.startsWith(prefix) ? legacyQName : `${prefix}${legacyQName}`;
}

export function sourceQNameForPath(serviceId: string, legacyQName: string, extension: string): string {
  return SERVICE_QUALIFIED_SOURCE_EXTENSIONS.has(extension.toLowerCase())
    ? serviceSourceQName(serviceId, legacyQName)
    : legacyQName;
}

export function owningRegisteredRepo(
  absolutePath: string,
  registeredRepoRoots: readonly string[],
): string | null {
  if (!path.isAbsolute(absolutePath)) return null;
  const candidates = registeredRepoRoots
    .filter((root) => path.isAbsolute(root) && (absolutePath === root || absolutePath.startsWith(root + path.sep)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return candidates[0] ?? null;
}

export function endpointQName(serviceId: string, method: HttpMethod, route: string): string {
  const normalized = normalizeRoutePath(route);
  if (normalized === null) throw new Error(`Invalid endpoint route: ${route}`);
  return `endpoint:${serviceId}:${method}:${normalized}`;
}

export function httpCallQName(
  sourceServiceId: string,
  fileQName: string,
  line: number,
  column: number,
): string {
  return `http-call:${sourceServiceId}:${fileQName}:${line}:${column}`;
}

export function eventChannelQName(transport: 'kafka' | 'celery', channel: string): string | null {
  if (!channel.trim() || CONTROL.test(channel)) return null;
  return `event:${transport}:${channel}`;
}

export function readHttpCallMetadata(value: unknown): HttpCallMetadata | null {
  if (!isRecord(value) || !exactKeys(value, [
    'contract', 'source_service', 'target_host', 'method', 'path',
  ])) return null;
  if (value.contract !== 'http-call-v1' || typeof value.source_service !== 'string'
    || typeof value.target_host !== 'string' || typeof value.method !== 'string'
    || typeof value.path !== 'string') return null;
  const method = normalizeHttpMethod(value.method);
  const normalizedPath = normalizeRoutePath(value.path);
  if (method === null || normalizedPath === null || normalizedPath !== value.path
    || !value.source_service || !value.target_host || CONTROL.test(value.source_service)
    || CONTROL.test(value.target_host)) return null;
  return {
    contract: 'http-call-v1', source_service: value.source_service,
    target_host: value.target_host, method, path: normalizedPath,
  };
}

export function readEndpointMetadata(value: unknown): EndpointMetadata | null {
  if (!isRecord(value) || !exactKeys(value, [
    'contract', 'service_id', 'service_aliases', 'method', 'path',
  ])) return null;
  if (value.contract !== 'http-endpoint-v1' || typeof value.service_id !== 'string'
    || !Array.isArray(value.service_aliases) || !value.service_aliases.every((alias) => typeof alias === 'string')
    || typeof value.method !== 'string' || typeof value.path !== 'string') return null;
  const method = normalizeHttpMethod(value.method);
  const normalizedPath = normalizeRoutePath(value.path);
  if (method === null || normalizedPath === null || normalizedPath !== value.path || !value.service_id
    || CONTROL.test(value.service_id)) return null;
  const aliases: string[] = [];
  for (const alias of value.service_aliases) {
    const normalized = normalizeServiceAlias(alias);
    if (normalized === null || normalized !== alias) return null;
    aliases.push(alias);
  }
  return {
    contract: 'http-endpoint-v1', service_id: value.service_id,
    service_aliases: [...new Set(aliases)].sort(), method, path: normalizedPath,
  };
}
