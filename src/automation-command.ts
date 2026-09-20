export type AutomationCommand =
  | { operation: 'capabilities' }
  | { operation: 'database_ensure' }
  | { operation: 'project_ensure'; slug: string; root: string }
  | { operation: 'targeted_ingest'; transcript: string; harness: 'codex' };
export function isAutomationInvocation(argv: readonly string[]): boolean {
  return ['capabilities', 'database', 'projects', 'ingest'].includes(argv[0] ?? '')
    && argv.some(token => token === '--json' || token.startsWith('--json='));
}
export function parseAutomationCommand(argv: readonly string[]): AutomationCommand {
  const verb = argv[0];
  const start = verb === 'database' || verb === 'projects' ? 2 : 1;
  if (start === 2 && argv[1] !== 'ensure') throw new Error('Invalid automation arguments');
  const allowed = verb === 'projects' ? ['json','slug','root']
    : verb === 'ingest' ? ['json','transcript','harness'] : ['json'];
  const flags = new Map<string,string | true>();
  for (let i = start; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error('Invalid automation arguments');
    const key = token.slice(2);
    if (!allowed.includes(key) || flags.has(key)) throw new Error('Invalid automation arguments');
    if (key === 'json') { flags.set(key,true); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Invalid automation arguments');
    flags.set(key,value);
  }
  if (flags.get('json') !== true) throw new Error('Invalid automation arguments');
  const value = (key: string): string => {
    const found = flags.get(key);
    if (typeof found !== 'string') throw new Error('Invalid automation arguments');
    return found;
  };
  if (verb === 'capabilities') return { operation:'capabilities' };
  if (verb === 'database') return { operation:'database_ensure' };
  if (verb === 'projects') return { operation:'project_ensure',slug:value('slug'),root:value('root') };
  if (verb === 'ingest' && value('harness') === 'codex')
    return { operation:'targeted_ingest',transcript:value('transcript'),harness:'codex' };
  throw new Error('Invalid automation arguments');
}
export function automationEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set(['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC',
    'TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TZ',
    'MAI_DB_URL','MAI_PROJECT_SLUG','MAI_BRAIN_ROOT']);
  const result: NodeJS.ProcessEnv = {};
  for (const [key,value] of Object.entries(source)) if (keep.has(key)) result[key] = value;
  return {...result,MAI_LLM_PROVIDER:'none',MAI_LLM_SUMMARY:'0',MAI_EMBEDDINGS:'0'};
}
