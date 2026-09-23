import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ViewHeader } from '../../components/ViewHeader';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import type {
  UserTaskGroup,
  UserTaskListResponse,
  UserTaskMutationResponse,
  UserTaskRemoveResponse,
  UserTaskRow,
} from '../../lib/types';
import { useProjects } from '../../shell/project';

type TaskTab = 'pending' | 'completed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TaskFocus =
  | { kind: 'plan'; planId: string }
  | { kind: 'unlinked' }
  | null;

function taskFocusFromHash(): TaskFocus {
  const query = window.location.hash.split('?')[1];
  if (!query) return null;
  const params = new URLSearchParams(query);
  const plans = params.getAll('plan');
  const groups = params.getAll('group');
  if (plans.length === 1 && groups.length === 0 && UUID_RE.test(plans[0])) {
    return { kind: 'plan', planId: plans[0].toLowerCase() };
  }
  if (groups.length === 1 && plans.length === 0 && groups[0] === 'unlinked') {
    return { kind: 'unlinked' };
  }
  return null;
}

function sameTaskFocus(left: TaskFocus, right: TaskFocus): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind
    && (left.kind !== 'plan' || (right.kind === 'plan' && left.planId === right.planId));
}

function groupTitle(group: UserTaskGroup): string {
  return group.group_kind === 'unlinked'
    ? 'Unlinked tasks'
    : group.plan_title ?? group.plan_path ?? 'Plan';
}

function focusHash(group: UserTaskGroup): string {
  return group.group_kind === 'plan' && group.plan_id
    ? `/tasks?plan=${encodeURIComponent(group.plan_id)}`
    : '/tasks?group=unlinked';
}

type RemoveTarget =
  | { label: string; count: 1; request: { mode: 'tasks'; task_ids: [string] } }
  | { label: string; count: number; request: { mode: 'group'; group_key: string; snapshot: string } };

function kindLabel(task: UserTaskRow): string {
  return task.kind === 'follow_up' ? 'follow-up' : 'blocking';
}

function sourceLabel(task: UserTaskRow): string {
  return task.source_kind === 'ad_hoc' ? 'ad-hoc' : 'plan';
}

function tasksForTab(group: UserTaskGroup, tab: TaskTab): UserTaskRow[] {
  return group.tasks.filter((task) => tab === 'pending'
    ? task.status === 'pending'
    : task.status !== 'pending');
}

function matchesSearch(group: UserTaskGroup, task: UserTaskRow, query: string): boolean {
  if (!query) return true;
  const haystack = [group.plan_title, group.plan_path, group.plan_sha, task.title, task.instructions]
    .filter((value): value is string => value !== null)
    .join('\n')
    .toLowerCase();
  return haystack.includes(query);
}

function TaskChip({ children, tone }: { children: string; tone: 'blocking' | 'follow' | 'source' }) {
  const colors = tone === 'blocking'
    ? 'bg-deny/15 text-deny'
    : tone === 'follow'
      ? 'bg-flow-400/15 text-flow-300'
      : 'bg-deep-800 text-ink-dim';
  return <span className={`rounded-full px-1.5 py-0.5 font-mono text-[0.62rem] ${colors}`}>{children}</span>;
}

function TaskCard({
  task,
  busy,
  onStatus,
  onDismiss,
  onRemove,
}: {
  task: UserTaskRow;
  busy: boolean;
  onStatus: (task: UserTaskRow, action: 'complete' | 'reopen') => void;
  onDismiss: (task: UserTaskRow) => void;
  onRemove: (task: UserTaskRow) => void;
}) {
  const pending = task.status === 'pending';
  return (
    <article data-testid="task-row" className="rounded-lg border border-deep-800 bg-deep-950/50 px-3 py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={pending ? 'false' : 'true'}
          aria-label={pending ? `Complete ${task.title}` : `Reopen ${task.title}`}
          disabled={busy}
          onClick={() => onStatus(task, pending ? 'complete' : 'reopen')}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border border-deep-700 text-xs text-flow-300 transition-colors enabled:hover:border-flow-400 disabled:opacity-40"
        >
          {pending ? null : '✓'}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-medium text-ink">{task.title}</h3>
            <TaskChip tone={task.kind === 'blocking' ? 'blocking' : 'follow'}>{kindLabel(task)}</TaskChip>
            <TaskChip tone="source">{sourceLabel(task)}</TaskChip>
            {!pending && <TaskChip tone="source">{task.status}</TaskChip>}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-dim">{task.instructions}</p>
          <p className="mt-1 font-mono text-[0.66rem] text-ink-faint">Assigned by {task.assigned_by_agent}</p>
          {task.resolution_note && (
            <p className="mt-1 text-xs text-ink-faint">reason: {task.resolution_note}</p>
          )}
          <div className="mt-2 flex items-center gap-3">
            {pending ? (
              <button type="button" disabled={busy} onClick={() => onDismiss(task)}
                className="text-xs text-deny enabled:hover:underline disabled:opacity-40">
                Dismiss {task.title}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => onRemove(task)}
                className="text-xs text-deny enabled:hover:underline disabled:opacity-40">
                Remove {task.title}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function TaskGroupCard({
  group,
  tasks,
  tab,
  busy,
  onStatus,
  onDismiss,
  onRemove,
  onRemoveGroup,
  onFocus,
}: {
  group: UserTaskGroup;
  tasks: UserTaskRow[];
  tab: TaskTab;
  busy: boolean;
  onStatus: (task: UserTaskRow, action: 'complete' | 'reopen') => void;
  onDismiss: (task: UserTaskRow) => void;
  onRemove: (task: UserTaskRow) => void;
  onRemoveGroup: (group: UserTaskGroup, count: number) => void;
  onFocus: (group: UserTaskGroup) => void;
}) {
  const unlinked = group.group_kind === 'unlinked';
  return (
    <section data-testid="task-group" className="rounded-xl border border-deep-800 bg-deep-900 px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-semibold text-ink">{groupTitle(group)}</h2>
            {group.plan_sha && (
              <span title={group.plan_sha} className="font-mono text-[0.66rem] text-flow-300">
                @ {group.plan_sha.slice(0, 8)}
              </span>
            )}
          </div>
          {!unlinked && <p className="font-mono text-[0.66rem] text-ink-faint">{group.plan_path}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 font-mono text-[0.66rem] text-ink-faint">
          <button type="button" onClick={() => onFocus(group)}
            className="rounded-md border border-deep-700 px-2 py-1 text-xs text-flow-300 transition-colors hover:border-flow-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-flow-400"
            aria-label={`Focus ${groupTitle(group)}`}>
            Focus
          </button>
          {group.plan_status && <TaskChip tone="source">{group.plan_status}</TaskChip>}
          <span>{tasks.length} {tab}</span>
          {tab === 'pending' && <span>{tasks.filter((task) => task.kind === 'blocking').length} blocking</span>}
          {tab === 'completed' && group.removal_snapshot && (
            <button type="button" disabled={busy} onClick={() => onRemoveGroup(group, tasks.length)}
              className="text-deny enabled:hover:underline disabled:opacity-40">
              {unlinked ? 'Remove all unlinked tasks' : 'Remove all from this plan'}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} busy={busy}
            onStatus={onStatus} onDismiss={onDismiss} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}

function FocusedTaskGroup({
  group,
  busy,
  onStatus,
  onDismiss,
  onRemove,
  onRemoveGroup,
}: {
  group: UserTaskGroup;
  busy: boolean;
  onStatus: (task: UserTaskRow, action: 'complete' | 'reopen') => void;
  onDismiss: (task: UserTaskRow) => void;
  onRemove: (task: UserTaskRow) => void;
  onRemoveGroup: (group: UserTaskGroup, count: number) => void;
}) {
  const outstanding = tasksForTab(group, 'pending');
  const completed = tasksForTab(group, 'completed');
  return (
    <section data-testid="focused-task-group" className="rounded-xl border border-flow-400/30 bg-deep-900 px-4 py-4">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold text-ink">{groupTitle(group)}</h2>
            {group.plan_sha && (
              <span title={group.plan_sha} className="font-mono text-[0.66rem] text-flow-300">
                @ {group.plan_sha.slice(0, 8)}
              </span>
            )}
          </div>
          {group.group_kind === 'plan' && (
            <p className="font-mono text-[0.66rem] text-ink-faint">{group.plan_path}</p>
          )}
        </div>
        {group.plan_status && <TaskChip tone="source">{group.plan_status}</TaskChip>}
      </div>

      <section aria-labelledby="outstanding-tasks-heading">
        <h3 id="outstanding-tasks-heading" className="mb-2 text-sm font-semibold text-ink">
          Outstanding ({outstanding.length})
        </h3>
        <div className="flex flex-col gap-2">
          {outstanding.map((task) => (
            <TaskCard key={task.id} task={task} busy={busy}
              onStatus={onStatus} onDismiss={onDismiss} onRemove={onRemove} />
          ))}
          {outstanding.length === 0 && <p className="text-sm text-ink-faint">No outstanding tasks.</p>}
        </div>
      </section>

      <section aria-labelledby="completed-tasks-heading" className="mt-5 border-t border-deep-800 pt-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="completed-tasks-heading" className="text-sm font-semibold text-ink-dim">
            Completed ({completed.length})
          </h3>
          {completed.length > 0 && group.removal_snapshot && (
            <button type="button" disabled={busy} onClick={() => onRemoveGroup(group, completed.length)}
              className="text-xs text-deny enabled:hover:underline disabled:opacity-40">
              {group.group_kind === 'unlinked' ? 'Remove all unlinked tasks' : 'Remove all from this plan'}
            </button>
          )}
        </div>
        <div className="flex flex-col gap-2 opacity-90">
          {completed.map((task) => (
            <TaskCard key={task.id} task={task} busy={busy}
              onStatus={onStatus} onDismiss={onDismiss} onRemove={onRemove} />
          ))}
          {completed.length === 0 && <p className="text-sm text-ink-faint">No completed tasks.</p>}
        </div>
      </section>
    </section>
  );
}

export function MyTasks({ onTasksChanged }: { onTasksChanged: () => void }) {
  const { project } = useProjects();
  const projectRef = useRef(project);
  projectRef.current = project;
  const requestGeneration = useRef(0);
  const previousProjectRef = useRef(project);
  const projectGeneration = useRef(0);
  const mountedRef = useRef(false);
  const reloadRef = useRef<(afterMutation?: boolean, preserveSnapshot?: boolean) => void>(() => {});
  const tabRefs = useRef<Record<TaskTab, HTMLButtonElement | null>>({ pending: null, completed: null });
  const removeDialogRef = useRef<HTMLDivElement | null>(null);
  const removeCancelRef = useRef<HTMLButtonElement | null>(null);
  const removeTriggerRef = useRef<HTMLElement | null>(null);
  const removeFallbackRef = useRef<HTMLDivElement | null>(null);
  const removeSucceededRef = useRef(false);
  const busyMutationRef = useRef<string | null>(null);
  const [data, setData] = useState<UserTaskListResponse | null>(null);
  const [dataProject, setDataProject] = useState<string | null>(null);
  const [tab, setTab] = useState<TaskTab>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mutationRefreshFailed, setMutationRefreshFailed] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [busyMutation, setBusyMutation] = useState<string | null>(null);
  const [dismissTask, setDismissTask] = useState<UserTaskRow | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissError, setDismissError] = useState('');
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [focus, setFocus] = useState(taskFocusFromHash);
  const [search, setSearch] = useState('');
  busyMutationRef.current = busyMutation;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const update = () => {
      const nextFocus = taskFocusFromHash();
      setFocus((currentFocus) => sameTaskFocus(currentFocus, nextFocus) ? currentFocus : nextFocus);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    if (!removeTarget) return;
    const dialog = removeDialogRef.current;
    const trigger = removeTriggerRef.current;
    removeCancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busyMutationRef.current === null) {
        event.preventDefault();
        setRemoveTarget(null);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown);
      if (removeSucceededRef.current) {
        removeSucceededRef.current = false;
        removeFallbackRef.current?.focus();
      } else if (trigger && document.contains(trigger)) trigger.focus();
      else removeFallbackRef.current?.focus();
    };
  }, [removeTarget]);

  const reload = useCallback((afterMutation = false, preserveSnapshot = false) => {
    const requestProject = project;
    if (!requestProject || projectRef.current !== requestProject) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError('');
    setMutationRefreshFailed(false);
    if (!preserveSnapshot) {
      setData(null);
      setDataProject(null);
    }
    apiGet<UserTaskListResponse>('/user-tasks', {
      history: 1,
      ...(focus?.kind === 'plan' ? { plan: focus.planId } : {}),
    })
      .then((response) => {
        if (requestGeneration.current !== generation || projectRef.current !== requestProject) return;
        setData(response);
        setDataProject(requestProject);
      })
      .catch((cause) => {
        if (requestGeneration.current === generation && projectRef.current === requestProject) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setMutationRefreshFailed(afterMutation);
        }
      })
      .finally(() => {
        if (requestGeneration.current === generation && projectRef.current === requestProject) setLoading(false);
      });
  }, [focus, project]);

  reloadRef.current = reload;

  useEffect(() => {
    const projectChanged = previousProjectRef.current !== project;
    previousProjectRef.current = project;
    if (projectChanged) {
      projectGeneration.current += 1;
      setTab('pending');
      setBusyMutation(null);
      if (focus !== null) {
        window.location.hash = '/tasks';
        return () => { requestGeneration.current += 1; };
      }
    }
    setMutationError('');
    setDismissTask(null);
    setRemoveTarget(null);
    reload();
    return () => { requestGeneration.current += 1; };
  }, [focus, project, reload]);

  const changeStatus = useCallback(async (
    task: UserTaskRow,
    action: 'complete' | 'reopen' | 'dismiss',
    reason?: string,
  ) => {
    if (busyMutation) return;
    const requestProject = project;
    const generation = projectGeneration.current;
    if (!requestProject || dataProject !== requestProject) return;
    setBusyMutation(`status:${task.id}`);
    setMutationError('');
    try {
      await apiPost<UserTaskMutationResponse>('/user-tasks/status', {
        task_id: task.id,
        action,
        ...(reason === undefined ? {} : { reason }),
      });
      if (!mountedRef.current || projectGeneration.current !== generation || projectRef.current !== requestProject) return;
      setBusyMutation(null);
      onTasksChanged();
      reloadRef.current(true);
    } catch (cause) {
      if (mountedRef.current && projectGeneration.current === generation && projectRef.current === requestProject) {
        setMutationError(cause instanceof Error ? cause.message : String(cause));
        setBusyMutation(null);
      }
    }
  }, [busyMutation, dataProject, onTasksChanged, project]);

  const openDismiss = useCallback((task: UserTaskRow) => {
    setDismissTask(task);
    setDismissReason('');
    setDismissError('');
  }, []);

  const confirmDismiss = (event: FormEvent) => {
    event.preventDefault();
    const reason = dismissReason.trim();
    if (!reason || !dismissTask) {
      setDismissError('Reason is required.');
      return;
    }
    const task = dismissTask;
    setDismissTask(null);
    setDismissReason('');
    void changeStatus(task, 'dismiss', reason);
  };

  const openTaskRemoval = useCallback((task: UserTaskRow) => {
    removeSucceededRef.current = false;
    removeTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRemoveTarget({
      label: task.title,
      count: 1,
      request: { mode: 'tasks', task_ids: [task.id] },
    });
  }, []);

  const openGroupRemoval = useCallback((group: UserTaskGroup, count: number) => {
    if (!group.removal_snapshot) return;
    removeSucceededRef.current = false;
    removeTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRemoveTarget({
      label: groupTitle(group),
      count,
      request: { mode: 'group', group_key: group.group_key, snapshot: group.removal_snapshot },
    });
  }, []);

  const confirmRemoval = async (event: FormEvent) => {
    event.preventDefault();
    if (!removeTarget || busyMutation) return;
    const target = removeTarget;
    const requestProject = project;
    const generation = projectGeneration.current;
    if (!requestProject || dataProject !== requestProject) return;
    setBusyMutation(`remove:${target.label}`);
    setMutationError('');
    try {
      await apiPost<UserTaskRemoveResponse>('/user-tasks/remove', { ...target.request });
      if (!mountedRef.current || projectGeneration.current !== generation || projectRef.current !== requestProject) return;
      setBusyMutation(null);
      removeSucceededRef.current = true;
      setRemoveTarget(null);
      reloadRef.current(true);
    } catch (cause) {
      if (!mountedRef.current || projectGeneration.current !== generation || projectRef.current !== requestProject) return;
      setMutationError(cause instanceof Error ? cause.message : String(cause));
      setBusyMutation(null);
      setRemoveTarget(null);
      if (cause instanceof ApiError && cause.status === 409) reloadRef.current(false, true);
    }
  };

  const scopedData = dataProject === project ? data : null;
  const normalizedSearch = search.trim().toLowerCase();
  const historyCount = scopedData?.rows.filter((task) => task.status !== 'pending').length ?? 0;
  const selectedGroups = scopedData?.groups
    .map((group) => ({
      group,
      tasks: tasksForTab(group, tab).filter((task) => matchesSearch(group, task, normalizedSearch)),
    }))
    .filter(({ tasks }) => tasks.length > 0) ?? [];
  const empty = scopedData !== null && scopedData.rows.length === 0;
  const focusedGroup = focus === null || scopedData === null
    ? null
    : scopedData.groups.find((group) => focus.kind === 'plan'
      ? group.group_key === `plan:${focus.planId}`
      : group.group_key === 'unlinked') ?? null;

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: TaskTab) => {
    const keys: TaskTab[] = ['pending', 'completed'];
    let next: TaskTab | null = null;
    if (event.key === 'ArrowRight') next = keys[(keys.indexOf(current) + 1) % keys.length];
    else if (event.key === 'ArrowLeft') next = keys[(keys.indexOf(current) - 1 + keys.length) % keys.length];
    else if (event.key === 'Home') next = keys[0];
    else if (event.key === 'End') next = keys[keys.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div ref={removeFallbackRef} tabIndex={-1} data-testid="my-tasks-view"
      className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="My Tasks" subtitle="operator-owned work that persists across agent sessions" />

      {focus !== null && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-flow-400/30 bg-flow-400/10 px-3 py-2 text-xs text-flow-300">
          <span>Focused on one task group.</span>
          <button type="button" className="underline" onClick={() => { window.location.hash = '/tasks'; }}>
            Back to all tasks
          </button>
        </div>
      )}

      {focus === null && (
        <label className="mb-4 block text-xs text-ink-dim">
          Search tasks and plans
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Plan name, SHA, task title, or instructions"
            className="mt-1 block w-full rounded-lg border border-deep-700 bg-deep-900 px-3 py-2 text-sm text-ink" />
        </label>
      )}

      {focus === null && scopedData && (
        <div className="mb-5 grid grid-cols-3 gap-3" aria-label="Task totals">
          {[
            ['Pending', scopedData.pending_count],
            ['Blocking', scopedData.blocking_count],
            ['Follow-up', scopedData.follow_up_count],
          ].map(([label, count]) => (
            <div key={label} className="rounded-xl border border-deep-800 bg-deep-900 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-ink-faint">{label}</p>
              <p className="mt-1 font-mono text-xl text-ink">{count}</p>
            </div>
          ))}
        </div>
      )}

      {loading && !scopedData && <p className="text-sm text-ink-faint">loading tasks…</p>}
      {loading && scopedData && <p className="mb-3 text-xs text-ink-faint">refreshing tasks…</p>}
      {!loading && error && !scopedData && (
        <div role="alert" className="rounded-xl border border-deny/40 bg-deny/10 px-4 py-3 text-sm text-deny">
          <p>{mutationRefreshFailed ? `Mutation applied; refresh failed: ${error}` : error}</p>
          <button type="button" onClick={() => reload(mutationRefreshFailed)} className="mt-2 text-xs underline">Retry</button>
        </div>
      )}
      {mutationError && <p className="mb-3 text-sm text-deny" role="alert">{mutationError}</p>}
      {!loading && !error && focus === null && empty && (
        <p className="text-sm text-ink-faint">No operator tasks for this project.</p>
      )}
      {!loading && !error && focus !== null && focusedGroup === null && (
        <p className="text-sm text-ink-faint">
          {focus.kind === 'plan' ? 'No visible tasks for this plan.' : 'No visible unlinked tasks.'}
        </p>
      )}

      {scopedData && focus !== null && focusedGroup && (
        <FocusedTaskGroup group={focusedGroup} busy={busyMutation !== null}
          onStatus={(task, action) => { void changeStatus(task, action); }}
          onDismiss={openDismiss} onRemove={openTaskRemoval} onRemoveGroup={openGroupRemoval} />
      )}

      {scopedData && focus === null && !empty && (
        <>
          <div role="tablist" aria-label="Task status" className="mb-4 flex gap-2">
            {([
              ['pending', `Pending (${scopedData.pending_count})`],
              ['completed', `Completed (${historyCount})`],
            ] as const).map(([value, label]) => (
              <button key={value} ref={(node) => { tabRefs.current[value] = node; }}
                id={`task-tab-${value}`} type="button" role="tab" aria-selected={tab === value}
                aria-controls="task-tabpanel" tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)} onKeyDown={(event) => onTabKeyDown(event, value)}
                className={`rounded-lg px-3 py-1.5 text-sm ${tab === value ? 'bg-flow-400/15 text-flow-300' : 'text-ink-dim'}`}>
                {label}
              </button>
            ))}
          </div>
          <div id="task-tabpanel" role="tabpanel" aria-labelledby={`task-tab-${tab}`}
            className="flex flex-col gap-4">
            {selectedGroups.map(({ group, tasks }) => (
              <TaskGroupCard key={group.group_key} group={group} tasks={tasks} tab={tab}
                busy={busyMutation !== null}
                onStatus={(task, action) => { void changeStatus(task, action); }}
                onDismiss={openDismiss} onRemove={openTaskRemoval} onRemoveGroup={openGroupRemoval}
                onFocus={(groupToFocus) => { window.location.hash = focusHash(groupToFocus); }} />
            ))}
            {selectedGroups.length === 0 && (
              <p className="text-sm text-ink-faint">
                {normalizedSearch
                  ? 'No tasks match this search.'
                  : tab === 'pending'
                  ? 'No pending operator tasks for this project.'
                  : 'No completed operator tasks for this project.'}
              </p>
            )}
          </div>
        </>
      )}

      {dismissTask && (
        <div role="dialog" aria-modal="true" aria-labelledby="dismiss-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep-950/80 px-4">
          <form onSubmit={confirmDismiss} className="w-full max-w-md rounded-xl border border-deep-700 bg-deep-900 p-5 shadow-xl">
            <h2 id="dismiss-title" className="text-base font-semibold text-ink">Dismiss {dismissTask.title}</h2>
            <label className="mt-4 block text-xs text-ink-dim">
              Reason
              <textarea autoFocus required value={dismissReason} onChange={(event) => {
                setDismissReason(event.target.value);
                if (event.target.value.trim()) setDismissError('');
              }} className="mt-1 min-h-24 w-full rounded-lg border border-deep-700 bg-deep-950 px-3 py-2 text-sm text-ink outline-none focus:border-flow-400" />
            </label>
            {dismissError && <p className="mt-1 text-xs text-deny">{dismissError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDismissTask(null)}
                className="rounded-lg border border-deep-700 px-3 py-1.5 text-sm text-ink-dim">Cancel</button>
              <button type="submit" className="rounded-lg bg-deny/15 px-3 py-1.5 text-sm text-deny">Confirm dismiss</button>
            </div>
          </form>
        </div>
      )}

      {removeTarget && (
        <div ref={removeDialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-title"
          aria-describedby="remove-description" tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep-950/80 px-4">
          <form onSubmit={(event) => { void confirmRemoval(event); }}
            className="w-full max-w-md rounded-xl border border-deep-700 bg-deep-900 p-5 shadow-xl">
            <h2 id="remove-title" className="text-base font-semibold text-ink">Remove {removeTarget.label}</h2>
            <p className="mt-2 text-xs text-ink-dim">{removeTarget.count} {removeTarget.count === 1 ? 'task' : 'tasks'}</p>
            <p id="remove-description" className="mt-4 text-sm text-ink-dim">
              These tasks will stop appearing in My Tasks and normal agent reads. They cannot be restored in the dashboard.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button ref={removeCancelRef} type="button" disabled={busyMutation !== null}
                onClick={() => setRemoveTarget(null)}
                className="rounded-lg border border-deep-700 px-3 py-1.5 text-sm text-ink-dim disabled:opacity-40">Cancel</button>
              <button type="submit" disabled={busyMutation !== null}
                className="rounded-lg bg-deny/15 px-3 py-1.5 text-sm text-deny disabled:opacity-40">Confirm remove</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
