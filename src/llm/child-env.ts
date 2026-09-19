// Shared ALLOWLIST child-env builder for the subscription providers
// (claude-code + codex-cli). SECURITY CONTRACT — decision 48797d3e
// (user-approved 2026-08-11): an LLM-driven subprocess inherits no unrelated
// secrets. The child env contains ONLY the base vars below (plus every LC_*
// locale var, plus the caller's named extras), each copied from process.env
// when set. OPENAI_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — and
// every other secret — are absent BY CONSTRUCTION: a CLI preferring env
// credentials over its login would silently API-bill the very users the
// subscription providers exist to spare. RULE: any further genuinely-required
// var is added deliberately WITH a test — never by widening to a drop-list.
const BASE_ALLOWLIST: readonly string[] = [
  'PATH', // find the binary
  'HOME', // CLI auth state lives under it (~/.codex, ~/.claude)
  'USER', // proven required for claude CLI stored-login resolution (decision 3be62c3b); codex needs it not, but the shared contract carries it once
  'TERM',
  'LANG', // locale (LC_* handled by prefix in the builder)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE', // enterprise certs
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

/** Build the allowlist-shaped child env — cast-free: Object.entries narrows
 * each value from string | undefined before it is copied. `extraVars` is the
 * per-provider addition (codex: CODEX_HOME; claude: CLAUDE_CONFIG_DIR). */
export function subscriptionChildEnv(extraVars: readonly string[] = []): Record<string, string> {
  // Windows environment names are case-insensitive and the block usually
  // spells the search path `Path`; an exact-key allowlist would hand the child
  // no PATH at all there. POSIX keeps exact matching (PATH and Path differ).
  const fold = (name: string): string => process.platform === 'win32' ? name.toUpperCase() : name;
  const allowed = new Set<string>([...BASE_ALLOWLIST, ...extraVars].map(fold));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allowed.has(fold(k)) || k.startsWith('LC_')) env[k] = v;
  }
  return env;
}
