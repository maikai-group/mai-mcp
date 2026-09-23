// Typed API client for the mai-brain-web JSON surface. Mirrors web/app.js:
// project + token live in localStorage; every call carries ?project=<slug> and
// (when set) the x-mai-brain-token header. The server envelope is
// { ok: true, ...payload } | { ok: false, error }.

const API = '/api';
const LS_PROJECT = 'mai-project';
const LS_TOKEN = 'mai-brain-token';

// Capture ?token= from the URL once at load and persist it (first-run wiring),
// then strip it so it doesn't linger in the address bar.
function captureTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const t = url.searchParams.get('token');
  if (t) {
    localStorage.setItem(LS_TOKEN, t);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  }
}
captureTokenFromUrl();

let currentProject = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_PROJECT) ?? '' : '';

export function getProject(): string {
  return currentProject;
}

export function setProject(slug: string): void {
  currentProject = slug;
  if (typeof localStorage !== 'undefined') localStorage.setItem(LS_PROJECT, slug);
}

function token(): string {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_TOKEN) ?? '' : '';
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const t = token();
  if (t) h['x-mai-brain-token'] = t;
  return h;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface Envelope { ok: boolean; error?: string }

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>, options?: {signal?: AbortSignal}): Promise<T> {
  const merged = { ...(params ?? {}), project: currentProject };
  const res = await fetch(API + path + buildQuery(merged), { headers: authHeaders(), signal: options?.signal });
  const json = (await res.json().catch((error: unknown) => { if (options?.signal?.aborted) throw error; return { ok: false, error: 'response was not json' }; })) as Envelope & T;
  options?.signal?.throwIfAborted();
  if (!res.ok || !json.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
  return json;
}

export async function apiPost<T>(path: string, body: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<T> {
  const res = await fetch(API + path + buildQuery({ project: currentProject }), {
    method: 'POST',
    signal: options?.signal,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch((error: unknown) => { if (options?.signal?.aborted) throw error; return { ok: false, error: 'response was not json' }; })) as Envelope & T;
  options?.signal?.throwIfAborted();
  if (!res.ok || !json.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
  return json;
}
