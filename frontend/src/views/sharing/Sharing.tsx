// Sharing — operator surface for cross-project references (plan 31).
// Inbound: what linked projects share into this one (incl. suppressed
// tombstone bodies — the operator may read what agents cannot). Outbound:
// this project's grants, revocable with a reason. Audit: the share_events
// trail. Env links are shown read-only: the dashboard never edits repo files.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewHeader, PanelState } from '../../components/ViewHeader';
import { apiGet, apiPost } from '../../lib/api';
import { useProjects } from '../../shell/project';

type ShareKind = 'decision' | 'doc' | 'handoff' | 'idea';
const KINDS: ShareKind[] = ['decision', 'doc', 'handoff', 'idea'];
function isShareKind(value: string): value is ShareKind {
  return KINDS.some((kind) => kind === value);
}

interface LiveState { status: string; detail: string | null; note: string | null }
interface SnapshotRef { kind: 'decision' | 'commit' | 'session' | 'file'; id?: string; path?: string }
interface ShareRow {
  id: string; direction: 'in' | 'out'; kind: ShareKind; status: string;
  source_slug: string; current_source_slug: string; target_slug: string; headline: string; body: string;
  detail: string; fields: Record<string, string | SnapshotRef[]>; note: string | null; live: LiveState | null;
  created_at: string; revoked_at: string | null; revoked_reason: string | null;
  link_state: 'linked' | 'pending' | 'dark';
}
interface LinkState {
  source_slug: string; current_source_slug: string | null;
  state: 'linked' | 'pending' | 'dark'; detail: string;
}
interface EventRow {
  id: string; event: string; source_slug: string; target_slug: string;
  artifact_kind: string; headline: string; actor_surface: string; note: string | null; created_at: string;
}
interface Candidate { kind: ShareKind; id: string | null; path: string | null; repo_root: string | null; headline: string; detail: string }

type Tab = 'inbound' | 'outbound' | 'audit';

// Theme tokens, never raw palette: deny = retract/revoke states, kind-schema =
// drift/pending amber (frontend/src/styles/theme.css — the be-water system
// every other view uses).
function badgeClass(state: string): string {
  if (state === 'ok' || state === 'active') return 'bg-flow-400/15 text-flow-300';
  if (state === 'updated' || state === 'pending') return 'bg-kind-schema/15 text-kind-schema';
  return 'bg-deny/15 text-deny';
}

function Badge({ label }: { label: string }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 font-mono text-[0.62rem] ${badgeClass(label)}`}>{label}</span>
  );
}

function ShareCard({ row, onRevoke }: { row: ShareRow; onRevoke?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const state = row.status === 'revoked' ? 'revoked' : (row.live?.status ?? 'active');
  const other = row.direction === 'in' ? `from ${row.source_slug}` : `to ${row.target_slug}`;
  return (
    <div className="rounded-xl border border-deep-800 bg-deep-900 px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge label={state} />
        {row.direction === 'in' && row.link_state !== 'linked' && <Badge label={row.link_state} />}
        {row.live?.note && <span className="text-[0.68rem] text-ink-faint">{row.live.note}</span>}
        <span className="font-mono text-[0.68rem] text-ink-faint">{row.kind} · {other} · {row.id.slice(0, 8)}</span>
      </div>
      <p className="mt-1.5 text-sm text-ink">{row.headline}</p>
      <p className="mt-1 font-mono text-[0.68rem] text-ink-faint">granted {row.created_at.slice(0, 10)}</p>
      {row.live?.detail && <p className="mt-1 text-xs text-kind-schema/80">{row.live.detail}</p>}
      {row.direction === 'in' && row.link_state !== 'linked' && (
        <p className="mt-1 font-mono text-xs text-ink-faint">
          {row.link_state}: {row.link_state === 'pending'
            ? `run mai link ${row.target_slug} --with ${row.source_slug}`
            : `source was ${row.source_slug}, current slug is ${row.current_source_slug ?? 'missing'}`}
        </p>
      )}
      {row.note && <p className="mt-1 text-xs text-ink-dim">note: {row.note}</p>}
      {row.revoked_reason && <p className="mt-1 text-xs text-ink-faint">revoked: {row.revoked_reason}</p>}
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-flow-300 hover:underline">
          {open ? 'hide snapshot' : 'view snapshot'}
        </button>
        {onRevoke && row.status === 'active' && (
          <button type="button" onClick={() => onRevoke(row.id)} className="text-xs text-deny hover:underline">
            revoke
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-deep-800 bg-deep-950 px-3 py-2 text-xs text-ink-dim">
          {Object.entries(row.fields).map(([key, value]) =>
            `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
          ).join('\n')}
          {Object.keys(row.fields).length > 0 ? '\n\n' : ''}{row.body}
        </pre>
      )}
    </div>
  );
}

function GrantForm({ onGranted }: { onGranted: () => void }) {
  const { project, projects } = useProjects();
  const [kind, setKind] = useState<ShareKind>('decision');
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidateRequest = useRef(0);

  useEffect(() => {
    const request = ++candidateRequest.current;
    if (q.trim().length < 2) { setCandidates([]); return; }
    const t = window.setTimeout(() => {
      apiGet<{ rows: Candidate[] }>('/share-candidates', { kind, q })
        .then((r) => { if (candidateRequest.current === request) setCandidates(r.rows); })
        .catch(() => { if (candidateRequest.current === request) setCandidates([]); });
    }, 250);
    return () => { window.clearTimeout(t); candidateRequest.current += 1; };
  }, [kind, q]);

  const submit = async () => {
    if (!picked || !target) return;
    setBusy(true); setError('');
    try {
      await apiPost<{ message: string }>('/shares', {
        kind,
        artifact_id: picked.id ?? undefined,
        doc_path: picked.path ?? undefined,
        doc_repo_root: picked.repo_root ?? undefined,
        target_slug: target,
        note: note || undefined,
      });
      setPicked(null); setQ(''); setNote('');
      onGranted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const targets = projects.filter((p) => p.slug !== project);
  return (
    <div className="rounded-xl border border-deep-800 bg-deep-900 px-4 py-3">
      <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">Grant a new share (source: {project})</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={kind} onChange={(e) => {
          const value = e.target.value;
          if (isShareKind(value)) { setKind(value); setPicked(null); }
        }}
          className="rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-sm text-ink">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }}
          placeholder={kind === 'doc' ? 'search doc paths…' : 'search artifacts…'}
          className="w-64 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-sm text-ink outline-none focus:border-flow-400" />
        <select value={target} onChange={(e) => setTarget(e.target.value)}
          className="rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-sm text-ink">
          <option value="">→ target project…</option>
          {targets.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (why)"
          className="w-56 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-sm text-ink outline-none focus:border-flow-400" />
        <button type="button" disabled={!picked || !target || busy} onClick={submit}
          className="rounded-lg border border-deep-700 bg-deep-800 px-3 py-1 text-sm text-ink-dim enabled:hover:border-flow-400/60 enabled:hover:text-ink disabled:opacity-40">
          share
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-deny">{error}</p>}
      {candidates.length > 0 && !picked && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-deep-800">
          {candidates.map((c) => (
            <li key={c.id ?? `${c.repo_root ?? ''}:${c.path ?? c.headline}`}>
              <button type="button" onClick={() => setPicked(c)}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink-dim hover:bg-deep-800 hover:text-ink">
                <span className="font-mono text-ink-faint">[{c.detail}]</span> {c.headline}
                {c.repo_root && <span className="ml-1 font-mono text-[0.62rem] text-ink-faint">({c.repo_root})</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked && <p className="mt-2 text-xs text-flow-300">selected: {picked.headline}</p>}
    </div>
  );
}

export function Sharing() {
  const { project } = useProjects();
  const projectRef = useRef(project);
  projectRef.current = project;
  const requestGeneration = useRef(0);
  const [tab, setTab] = useState<Tab>('inbound');
  const [rows, setRows] = useState<ShareRow[]>([]);
  const [declared, setDeclared] = useState<string[]>([]);
  const [linkStates, setLinkStates] = useState<LinkState[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [nextAuditCursor, setNextAuditCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dataProject, setDataProject] = useState<string | null>(null);

  const reload = useCallback(() => {
    const requestProject = project;
    if (!requestProject || projectRef.current !== requestProject) return;
    const generation = ++requestGeneration.current;
    setLoading(true); setError(''); setDataProject(null);
    Promise.all([
      apiGet<{ rows: ShareRow[]; declared_links: string[]; link_states: LinkState[] }>('/shares', { direction: 'both' }),
      apiGet<{ rows: EventRow[]; next_cursor: string | null }>('/share-events'),
    ]).then(([s, e]) => {
      if (requestGeneration.current !== generation || projectRef.current !== requestProject) return;
      setRows(s.rows); setDeclared(s.declared_links); setLinkStates(s.link_states);
      setEvents(e.rows); setNextAuditCursor(e.next_cursor);
      setDataProject(requestProject);
    })
      .catch((e) => {
        if (requestGeneration.current === generation && projectRef.current === requestProject) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (requestGeneration.current === generation && projectRef.current === requestProject) setLoading(false);
      });
  }, [project]);

  useEffect(() => {
    reload();
    return () => { requestGeneration.current += 1; };
  }, [reload]);

  const revoke = useCallback((id: string) => {
    const reason = window.prompt('Revoke reason (required):');
    if (!reason || !reason.trim()) return;
    const requestProject = project;
    const generation = requestGeneration.current;
    apiPost<{ message: string }>('/shares/revoke', { share_id: id, reason })
      .then(() => {
        if (projectRef.current === requestProject && requestGeneration.current === generation) reload();
      })
      .catch((e) => {
        if (projectRef.current === requestProject && requestGeneration.current === generation) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [project, reload]);

  const loadMoreAudit = useCallback(() => {
    if (!nextAuditCursor || dataProject !== project) return;
    const cursor = nextAuditCursor;
    const requestProject = project;
    const generation = requestGeneration.current;
    apiGet<{ rows: EventRow[]; next_cursor: string | null }>('/share-events', { cursor })
      .then((page) => {
        if (requestGeneration.current !== generation || projectRef.current !== requestProject) return;
        setEvents((current) => [...current, ...page.rows]);
        setNextAuditCursor(page.next_cursor);
      })
      .catch((e) => {
        if (requestGeneration.current === generation && projectRef.current === requestProject) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [dataProject, nextAuditCursor, project]);

  const scoped = dataProject === project;
  const visibleRows = scoped ? rows : [];
  const visibleDeclared = scoped ? declared : [];
  const visibleLinkStates = scoped ? linkStates : [];
  const visibleEvents = scoped ? events : [];
  const visibleAuditCursor = scoped ? nextAuditCursor : null;
  const inbound = visibleRows.filter((r) => r.direction === 'in');
  const outbound = visibleRows.filter((r) => r.direction === 'out');
  const tabs: Array<[Tab, string, number]> = [
    ['inbound', 'Inbound', inbound.length], ['outbound', 'Outbound', outbound.length], ['audit', 'Audit', visibleEvents.length],
  ];

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="Sharing" subtitle="operator-owned cross-project references — read-only, per-artifact, revocable" />
      <div className="mb-3 rounded-lg border border-deep-800 bg-deep-900 px-4 py-2 text-xs text-ink-dim">
        declared links (env is written by <span className="font-mono">mai link</span> — the dashboard never edits repo files):{' '}
        <span className="font-mono text-ink">{visibleDeclared.length > 0 ? visibleDeclared.join(', ') : '(none)'}</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {visibleLinkStates.map((link) => (
            <span key={link.source_slug} className="font-mono">
              <Badge label={link.state} /> {link.source_slug}
              {link.current_source_slug && link.current_source_slug !== link.source_slug
                ? ` → ${link.current_source_slug}` : ''} — {link.detail}
            </span>
          ))}
        </div>
      </div>
      <div className="mb-4 flex gap-1">
        {tabs.map(([t, label, n]) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-deep-800 text-ink' : 'text-ink-dim hover:text-ink'}`}>
            {label} <span className="font-mono text-[0.62rem] text-ink-faint">{n}</span>
          </button>
        ))}
      </div>
      <PanelState loading={loading} error={error} empty={false} />
      {!loading && !error && tab === 'inbound' && (
        <div className="flex flex-col gap-2">
          {inbound.length === 0 && <p className="text-sm text-ink-faint">Nothing shared into this project.</p>}
          {inbound.map((r) => <ShareCard key={r.id} row={r} />)}
        </div>
      )}
      {!loading && !error && tab === 'outbound' && (
        <div className="flex flex-col gap-3">
          <GrantForm key={project} onGranted={reload} />
          {outbound.length === 0 && <p className="text-sm text-ink-faint">This project has granted nothing.</p>}
          {outbound.map((r) => <ShareCard key={r.id} row={r} onRevoke={revoke} />)}
        </div>
      )}
      {!loading && !error && tab === 'audit' && (
        <div className="flex flex-col gap-1.5">
          {visibleEvents.length === 0 && <p className="text-sm text-ink-faint">No share events touch this project.</p>}
          {visibleEvents.map((e) => (
            <div key={e.id} className="rounded-lg border border-deep-800 bg-deep-900 px-4 py-2 text-xs text-ink-dim">
              <span className="font-mono text-ink-faint">{e.created_at.slice(0, 16).replace('T', ' ')}</span>{' '}
              <Badge label={e.event} /> {e.artifact_kind} {e.source_slug} → {e.target_slug} · via {e.actor_surface}
              <p className="mt-0.5 text-ink">{e.headline}</p>
              {e.note && <p className="text-ink-faint">note: {e.note}</p>}
            </div>
          ))}
          {visibleAuditCursor && (
            <button type="button" onClick={loadMoreAudit}
              className="mt-2 rounded-lg border border-deep-700 px-3 py-1.5 text-xs text-flow-300 hover:border-flow-400/60">
              Load more audit events
            </button>
          )}
        </div>
      )}
    </div>
  );
}
