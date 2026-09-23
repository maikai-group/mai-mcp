import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  UserTaskListResponse,
  UserTaskMutationResponse,
  UserTaskRow,
} from '../../lib/types';

const mocks = vi.hoisted(() => {
  class TestApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { apiGet: vi.fn(), apiPost: vi.fn(), ApiError: TestApiError };
});
const projectState = vi.hoisted(() => ({ current: 'project-a' }));
vi.mock('../../lib/api', () => ({
  ApiError: mocks.ApiError,
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));
vi.mock('../../shell/project', () => ({
  useProjects: () => ({ project: projectState.current, projects: [] }),
}));

import { MyTasks } from './MyTasks';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error('deferred not initialized'); };
  let reject = (_reason: unknown): void => { throw new Error('deferred not initialized'); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function task(overrides: Partial<UserTaskRow> & Pick<UserTaskRow, 'id' | 'title'>): UserTaskRow {
  return {
    project_id: 'project-a-id',
    plan_id: PLAN_ID,
    task_key: overrides.id,
    source_kind: 'plan',
    kind: 'blocking',
    instructions: `${overrides.title} instructions`,
    assigned_by_agent: 'agent-b',
    assigned_by_session: 'session-a',
    sort_order: 0,
    status: 'pending',
    resolution_note: null,
    resolved_at: null,
    created_at: '2026-08-27T12:00:00.000Z',
    updated_at: '2026-08-27T12:00:00.000Z',
    plan_title: 'Zeta Plan',
    plan_path: 'docs/zeta.md',
    plan_status: 'executing',
    plan_sha: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    plan_updated_at: '2026-08-27T12:00:00.000Z',
    ...overrides,
  };
}

const planFirst = task({ id: 'plan-first', title: 'Zulu first', assigned_by_agent: 'agent-z' });
const planSecond = task({
  id: 'plan-second', title: 'Alpha second', kind: 'follow_up', assigned_by_agent: 'agent-a', sort_order: 1,
});
const completed = task({
  id: 'completed', title: 'Completed task', status: 'completed',
  resolved_at: '2026-08-27T13:00:00.000Z',
});
const dismissed = task({
  id: 'dismissed', title: 'Dismissed task', status: 'dismissed', resolution_note: 'obsolete',
  resolved_at: '2026-08-27T13:00:00.000Z', sort_order: 2,
});
const adHocA = task({
  id: 'ad-hoc-a', title: 'Agent A task', plan_id: null, source_kind: 'ad_hoc',
  assigned_by_agent: 'agent-c', plan_title: null, plan_path: null, plan_status: null, plan_sha: null,
  plan_updated_at: null, instructions: 'Review the unlinked item.',
});
const adHocB = task({
  id: 'ad-hoc-b', title: 'Agent B task', plan_id: null, source_kind: 'ad_hoc',
  assigned_by_agent: 'agent-d', plan_title: null, plan_path: null, plan_status: null, plan_sha: null,
  plan_updated_at: null, sort_order: 1,
});
const adHocCompleted = task({
  id: 'ad-hoc-completed', title: 'Unlinked completed', plan_id: null, source_kind: 'ad_hoc',
  assigned_by_agent: 'agent-e', plan_title: null, plan_path: null, plan_status: null, plan_sha: null,
  plan_updated_at: null, status: 'completed', resolved_at: '2026-08-27T13:30:00.000Z', sort_order: 2,
});

const defaultRows = [planFirst, planSecond, completed, dismissed, adHocA, adHocB, adHocCompleted];

function response(rows: UserTaskRow[] = defaultRows): UserTaskListResponse {
  const planTasks = rows.filter((row) => row.plan_id === PLAN_ID);
  const unlinkedTasks = rows.filter((row) => row.plan_id === null);
  const pending = rows.filter((row) => row.status === 'pending');
  const groups = [];
  if (planTasks.length > 0) {
    groups.push({
      group_key: `plan:${PLAN_ID}` as const,
      group_kind: 'plan' as const,
      plan_id: PLAN_ID,
      plan_title: 'Zeta Plan',
      plan_path: 'docs/zeta.md',
      plan_status: 'executing',
      plan_sha: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      pending_count: planTasks.filter((row) => row.status === 'pending').length,
      blocking_count: planTasks.filter((row) => row.status === 'pending' && row.kind === 'blocking').length,
      follow_up_count: planTasks.filter((row) => row.status === 'pending' && row.kind === 'follow_up').length,
      removal_snapshot: planTasks.some((row) => row.status !== 'pending') ? 'a'.repeat(64) : null,
      tasks: planTasks,
    });
  }
  if (unlinkedTasks.length > 0) {
    groups.push({
      group_key: 'unlinked' as const,
      group_kind: 'unlinked' as const,
      plan_id: null,
      plan_title: null,
      plan_path: null,
      plan_status: null,
      plan_sha: null,
      pending_count: unlinkedTasks.filter((row) => row.status === 'pending').length,
      blocking_count: unlinkedTasks.filter((row) => row.status === 'pending' && row.kind === 'blocking').length,
      follow_up_count: unlinkedTasks.filter((row) => row.status === 'pending' && row.kind === 'follow_up').length,
      removal_snapshot: unlinkedTasks.some((row) => row.status !== 'pending') ? 'b'.repeat(64) : null,
      tasks: unlinkedTasks,
    });
  }
  return {
    pending_count: pending.length,
    blocking_count: pending.filter((row) => row.kind === 'blocking').length,
    follow_up_count: pending.filter((row) => row.kind === 'follow_up').length,
    rows,
    groups,
  };
}

function mutation(row: UserTaskRow): UserTaskMutationResponse {
  return { task: row, pending_count: 3, blocking_count: 2, follow_up_count: 1 };
}

function selectCompleted(): void {
  fireEvent.click(screen.getByRole('tab', { name: /Completed/ }));
}

describe('MyTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.current = 'project-a';
    window.location.hash = '/tasks';
    mocks.apiGet.mockResolvedValue(response());
    mocks.apiPost.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === '/user-tasks/remove') return Promise.resolve({ removed_count: 1 });
      const current = response().rows.find((row) => row.id === body.task_id);
      if (!current) throw new Error('missing fixture task');
      const status = body.action === 'reopen'
        ? 'pending'
        : body.action === 'dismiss' ? 'dismissed' : 'completed';
      return Promise.resolve(mutation({
        ...current,
        status,
        resolution_note: body.action === 'dismiss' ? String(body.reason) : null,
        resolved_at: status === 'pending' ? null : '2026-08-27T14:00:00.000Z',
      }));
    });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('defaults to Pending and renders plan/unlinked cards in server order with escaped text', async () => {
    const hostile = task({
      id: 'hostile', title: 'Literal body', sort_order: 3,
      instructions: '<img src=x onerror="alert(1)">\n**plain**',
    });
    mocks.apiGet.mockResolvedValue(response([
      planFirst, planSecond, hostile, completed, dismissed, adHocA, adHocB, adHocCompleted,
    ]));
    render(<MyTasks onTasksChanged={() => {}} />);
    const pendingTab = await screen.findByRole('tab', { name: 'Pending (5)' });
    expect(pendingTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Completed (3)' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Zeta Plan' })).toBeDefined();
    expect(screen.getByTitle('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'))
      .toHaveProperty('textContent', '@ abcdef01');
    const unlinked = screen.getByRole('heading', { name: 'Unlinked tasks' }).closest('[data-testid="task-group"]');
    if (!(unlinked instanceof HTMLElement)) throw new Error('unlinked group missing');
    expect(within(unlinked).getByText('Assigned by agent-c')).toBeDefined();
    expect(within(unlinked).getByText('Assigned by agent-d')).toBeDefined();
    const titles = screen.getAllByTestId('task-row').map((row) => within(row).getByRole('heading').textContent);
    expect(titles).toEqual(['Zulu first', 'Alpha second', 'Literal body', 'Agent A task', 'Agent B task']);
    expect(screen.queryByText('Completed task')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Literal body' }).closest('[data-testid="task-row"]')?.textContent)
      .toContain('<img src=x onerror="alert(1)">\n**plain**');
    expect(document.querySelector('img')).toBeNull();
  });

  it('searches plan identity and task content without changing the server totals', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: 'Pending (4)' });
    const search = screen.getByRole('searchbox', { name: 'Search tasks and plans' });

    fireEvent.change(search, { target: { value: 'abcdef01' } });
    expect(screen.getByText('Zulu first')).toBeDefined();
    expect(screen.queryByText('Agent A task')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Pending (4)' })).toBeDefined();

    fireEvent.change(search, { target: { value: 'zeta plan' } });
    expect(screen.getByText('Zulu first')).toBeDefined();
    expect(screen.queryByText('Agent A task')).toBeNull();

    fireEvent.change(search, { target: { value: 'docs/zeta.md' } });
    expect(screen.getByText('Alpha second')).toBeDefined();
    expect(screen.queryByText('Agent B task')).toBeNull();

    fireEvent.change(search, { target: { value: 'agent a task' } });
    expect(screen.getByText('Agent A task')).toBeDefined();
    expect(screen.queryByText('Zulu first')).toBeNull();

    fireEvent.change(search, { target: { value: 'agent b task instructions' } });
    expect(screen.getByText('Agent B task')).toBeDefined();
    expect(screen.queryByText('Zulu first')).toBeNull();

    fireEvent.change(search, { target: { value: 'missing value' } });
    expect(screen.getByText('No tasks match this search.')).toBeDefined();
  });

  it('opens an exact plan focus link and can return to all tasks', async () => {
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    render(<MyTasks onTasksChanged={() => {}} />);

    expect(await screen.findByText('Focused on one task group.')).toBeDefined();
    expect(mocks.apiGet).toHaveBeenCalledWith('/user-tasks', { history: 1, plan: PLAN_ID });
    expect(screen.getByRole('heading', { name: 'Outstanding (2)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Completed (2)' })).toBeDefined();
    expect(screen.getByText('Zulu first')).toBeDefined();
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(screen.queryByText('Agent A task')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/user-tasks', { history: 1 }));
  });

  it('shows completed and dismissed rows in their plan/unlinked cards with checked controls', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: 'Pending (4)' });
    selectCompleted();
    expect(screen.getByRole('heading', { name: 'Zeta Plan' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Unlinked tasks' })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Reopen Completed task' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Reopen Dismissed task' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('reason: obsolete')).toBeDefined();
    expect(screen.getAllByText('completed').length).toBeGreaterThan(0);
    expect(screen.getByText('dismissed')).toBeDefined();
  });

  it('implements roving tab focus, arrow/Home/End activation, and panel labelling', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    const pending = await screen.findByRole('tab', { name: 'Pending (4)' });
    const completedTab = screen.getByRole('tab', { name: 'Completed (3)' });
    const panel = screen.getByRole('tabpanel');
    expect(pending.tabIndex).toBe(0);
    expect(completedTab.tabIndex).toBe(-1);
    expect(panel.getAttribute('aria-labelledby')).toBe(pending.id);

    pending.focus();
    fireEvent.keyDown(pending, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(completedTab);
    expect(completedTab.getAttribute('aria-selected')).toBe('true');
    expect(completedTab.tabIndex).toBe(0);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(completedTab.id);

    fireEvent.keyDown(completedTab, { key: 'Home' });
    expect(document.activeElement).toBe(pending);
    expect(pending.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(pending, { key: 'End' });
    expect(document.activeElement).toBe(completedTab);
    fireEvent.keyDown(completedTab, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(pending);
  });

  it('posts exact complete, reopen, and reason-bearing dismiss payloads', async () => {
    const changed = vi.fn();
    const { unmount } = render(<MyTasks onTasksChanged={changed} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/status', {
      task_id: 'plan-first', action: 'complete',
    }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    unmount();

    render(<MyTasks onTasksChanged={changed} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reopen Completed task' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/status', {
      task_id: 'completed', action: 'reopen',
    }));
    cleanup();

    render(<MyTasks onTasksChanged={changed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Zulu first' }));
    const form = screen.getByRole('dialog').querySelector('form');
    if (!form) throw new Error('dismiss form missing');
    fireEvent.submit(form);
    expect(screen.getByText('Reason is required.')).toBeDefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: '  no longer needed  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/status', {
      task_id: 'plan-first', action: 'dismiss', reason: 'no longer needed',
    }));
  });

  it('confirms one-row removal, supports cancel, hides the stale snapshot, and skips the shell callback', async () => {
    const changed = vi.fn();
    const reconciliation = deferred<UserTaskListResponse>();
    mocks.apiGet.mockResolvedValueOnce(response()).mockReturnValueOnce(reconciliation.promise);
    render(<MyTasks onTasksChanged={changed} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(screen.getByText('1 task')).toBeDefined();
    expect(screen.getByText(/cannot be restored in the dashboard/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.apiPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/remove', {
      mode: 'tasks', task_ids: ['completed'],
    }));
    expect(await screen.findByText('loading tasks…')).toBeDefined();
    expect(screen.queryByText('Completed task')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('my-tasks-view')));
    expect(changed).not.toHaveBeenCalled();
    reconciliation.resolve(response(defaultRows.filter((row) => row.id !== 'completed')));
    expect(await screen.findByText('Dismissed task')).toBeDefined();
  });

  it('contains removal-dialog focus, closes with Escape, and restores the trigger', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    const trigger = screen.getByRole('button', { name: 'Remove Completed task' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Remove Completed task' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm remove' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(dialog.getAttribute('aria-describedby')).toBe('remove-description');

    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('posts plan-card removal with the server snapshot even above 100 rows', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => task({
      id: `terminal-${index}`,
      title: `Terminal ${index}`,
      status: index % 2 === 0 ? 'completed' : 'dismissed',
      resolution_note: index % 2 === 0 ? null : 'waived',
      resolved_at: '2026-08-27T13:00:00.000Z',
      sort_order: index,
    }));
    mocks.apiGet.mockResolvedValue(response(rows));
    const pending = deferred<unknown>();
    mocks.apiPost.mockReturnValue(pending.promise);
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: 'Pending (0)' });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove all from this plan' }));
    expect(screen.getByText('101 tasks')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/remove', {
      mode: 'group', group_key: `plan:${PLAN_ID}`, snapshot: 'a'.repeat(64),
    });
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty('task_ids');
  });

  it('posts unlinked-card removal with its server snapshot and never a UUID array', async () => {
    const pending = deferred<unknown>();
    mocks.apiPost.mockReturnValue(pending.promise);
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove all unlinked tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/remove', {
      mode: 'group', group_key: 'unlinked', snapshot: 'b'.repeat(64),
    });
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty('task_ids');
  });

  it('prevents removal double-submit and never offers Remove on pending rows', async () => {
    const pending = deferred<unknown>();
    mocks.apiPost.mockReturnValue(pending.promise);
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: /Pending/ });
    expect(screen.queryByRole('button', { name: /^Remove Zulu first$/ })).toBeNull();
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    const confirm = screen.getByRole('button', { name: 'Confirm remove' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it('retains rows on removal failure and refreshes authoritatively on 409 without blanking', async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error('remove failed'));
    const { unmount } = render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect((await screen.findByRole('alert')).textContent).toContain('remove failed');
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    unmount();

    vi.clearAllMocks();
    const refreshed = deferred<UserTaskListResponse>();
    mocks.apiGet.mockResolvedValueOnce(response()).mockReturnValueOnce(refreshed.promise);
    mocks.apiPost.mockRejectedValueOnce(new mocks.ApiError('stale removal', 409));
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect((await screen.findByRole('alert')).textContent).toContain('stale removal');
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(screen.getByText('refreshing tasks…')).toBeDefined();
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    refreshed.resolve(response(defaultRows.filter((row) => row.id !== 'completed')));
    await waitFor(() => expect(screen.queryByText('Completed task')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('stale removal');
  });

  it('shows selected-tab, global empty, API error, mutation-refresh error, and retry states', async () => {
    mocks.apiGet.mockResolvedValue(response([completed]));
    const { unmount } = render(<MyTasks onTasksChanged={() => {}} />);
    expect(await screen.findByText('No pending operator tasks for this project.')).toBeDefined();
    selectCompleted();
    expect(screen.getByText('Completed task')).toBeDefined();
    unmount();

    mocks.apiGet.mockResolvedValue(response([planFirst]));
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByText('Zulu first');
    selectCompleted();
    expect(screen.getByText('No completed operator tasks for this project.')).toBeDefined();
    cleanup();

    mocks.apiGet.mockResolvedValue(response([]));
    render(<MyTasks onTasksChanged={() => {}} />);
    expect(await screen.findByText('No operator tasks for this project.')).toBeDefined();
    cleanup();

    mocks.apiGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response([]));
    render(<MyTasks onTasksChanged={() => {}} />);
    expect(await screen.findByText('offline')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No operator tasks for this project.')).toBeDefined();
    cleanup();

    const reconciliation = deferred<UserTaskListResponse>();
    mocks.apiGet.mockResolvedValueOnce(response()).mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValueOnce(response([planFirst]));
    mocks.apiPost.mockResolvedValue(mutation({ ...planFirst, status: 'completed' }));
    render(<MyTasks onTasksChanged={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    reconciliation.reject(new Error('reconciliation failed'));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('Mutation applied; refresh failed: reconciliation failed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Zulu first')).toBeDefined();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it('focuses a linked card, shows both sections, and preserves search and tab on Back', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: 'Pending (4)' });
    const search = screen.getByRole('searchbox', { name: 'Search tasks and plans' });
    fireEvent.change(search, { target: { value: 'Zulu first' } });

    fireEvent.click(screen.getByRole('button', { name: 'Focus Zeta Plan' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/user-tasks', {
      history: 1,
      plan: PLAN_ID,
    }));

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByLabelText('Task totals')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Outstanding (2)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Completed (2)' })).toBeDefined();
    expect(screen.getByText('Zulu first')).toBeDefined();
    expect(screen.getByText('Alpha second')).toBeDefined();
    expect(screen.getByText('Completed task')).toBeDefined();
    expect(screen.getByText('Dismissed task')).toBeDefined();
    expect(screen.queryByText('Agent A task')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    const pendingTab = await screen.findByRole('tab', { name: 'Pending (4)' });
    expect(pendingTab.getAttribute('aria-selected')).toBe('true');
    const restoredSearch = screen.getByRole('searchbox', { name: 'Search tasks and plans' });
    expect(restoredSearch).toHaveProperty('value', 'Zulu first');

    fireEvent.change(restoredSearch, { target: { value: '' } });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Focus Zeta Plan' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`));
    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    const completedTab = await screen.findByRole('tab', { name: 'Completed (3)' });
    expect(completedTab.getAttribute('aria-selected')).toBe('true');
  });

  it('focuses all visible Unlinked work without adding a plan filter', async () => {
    render(<MyTasks onTasksChanged={() => {}} />);
    await screen.findByRole('tab', { name: 'Pending (4)' });
    fireEvent.click(screen.getByRole('button', { name: 'Focus Unlinked tasks' }));

    await waitFor(() => expect(window.location.hash).toBe('#/tasks?group=unlinked'));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenLastCalledWith('/user-tasks', { history: 1 }));
    expect(screen.getByRole('heading', { name: 'Outstanding (2)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Completed (1)' })).toBeDefined();
    expect(screen.getByText('Agent A task')).toBeDefined();
    expect(screen.getByText('Agent B task')).toBeDefined();
    expect(screen.getByText('Unlinked completed')).toBeDefined();
    expect(screen.queryByText('Zulu first')).toBeNull();
  });

  it('keeps plan focus while authoritative completion and reopen move a task', async () => {
    const movedRows = defaultRows.map((row) => row.id === 'plan-first'
      ? { ...row, status: 'completed' as const, resolved_at: '2026-08-27T14:00:00.000Z' }
      : row);
    mocks.apiGet.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(movedRows))
      .mockResolvedValueOnce(response());
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    render(<MyTasks onTasksChanged={() => {}} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    expect(await screen.findByRole('checkbox', { name: 'Reopen Zulu first' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Outstanding (1)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Completed (3)' })).toBeDefined();
    expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reopen Zulu first' }));
    expect(await screen.findByRole('checkbox', { name: 'Complete Zulu first' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Outstanding (2)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Completed (2)' })).toBeDefined();
    expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`);
  });

  it('dismisses a task while retaining plan focus', async () => {
    const dismissedRows = defaultRows.map((row) => row.id === 'plan-second'
      ? {
          ...row,
          status: 'dismissed' as const,
          resolution_note: 'not required',
          resolved_at: '2026-08-27T14:00:00.000Z',
        }
      : row);
    mocks.apiGet.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(dismissedRows));
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    render(<MyTasks onTasksChanged={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Alpha second' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'not required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));
    expect(await screen.findByRole('checkbox', { name: 'Reopen Alpha second' })).toBeDefined();
    expect(screen.getByText('reason: not required')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Outstanding (1)' })).toBeDefined();
    expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`);
  });

  it('removes the last plan task while retaining an actionable empty focus', async () => {
    mocks.apiGet.mockResolvedValueOnce(response([completed])).mockResolvedValueOnce(response([]));
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    render(<MyTasks onTasksChanged={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Completed task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(await screen.findByText('No visible tasks for this plan.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back to all tasks' })).toBeDefined();
    expect(window.location.hash).toBe(`#/tasks?plan=${PLAN_ID}`);
  });

  it('removes the last Unlinked group while retaining its actionable empty focus', async () => {
    mocks.apiGet.mockResolvedValueOnce(response([adHocCompleted])).mockResolvedValueOnce(response([]));
    window.location.hash = '/tasks?group=unlinked';
    render(<MyTasks onTasksChanged={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove all unlinked tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/user-tasks/remove', {
      mode: 'group', group_key: 'unlinked', snapshot: 'b'.repeat(64),
    }));
    expect(await screen.findByText('No visible unlinked tasks.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back to all tasks' })).toBeDefined();
    expect(window.location.hash).toBe('#/tasks?group=unlinked');
  });

  it('keeps the mutation lock and reconciles the current view across focus navigation', async () => {
    const pendingMutation = deferred<UserTaskMutationResponse>();
    const movedRows = defaultRows.map((row) => row.id === 'plan-first'
      ? { ...row, status: 'completed' as const, resolved_at: '2026-08-27T14:00:00.000Z' }
      : row);
    mocks.apiPost.mockReturnValueOnce(pendingMutation.promise);
    mocks.apiGet.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(movedRows));
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    render(<MyTasks onTasksChanged={() => {}} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to all tasks' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    const secondMutation = await screen.findByRole('checkbox', { name: 'Complete Alpha second' });
    expect(secondMutation).toHaveProperty('disabled', true);
    fireEvent.click(secondMutation);
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);

    pendingMutation.resolve(mutation({ ...planFirst, status: 'completed' }));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(
      screen.getByRole('checkbox', { name: 'Complete Alpha second' })
    ).toHaveProperty('disabled', false));
    selectCompleted();
    expect(await screen.findByRole('checkbox', { name: 'Reopen Zulu first' })).toBeDefined();
  });

  it('ignores a deferred mutation response after the component unmounts', async () => {
    const pendingMutation = deferred<UserTaskMutationResponse>();
    const onTasksChanged = vi.fn();
    mocks.apiPost.mockReturnValueOnce(pendingMutation.promise);
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    const view = render(<MyTasks onTasksChanged={onTasksChanged} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    view.unmount();
    pendingMutation.resolve(mutation({ ...planFirst, status: 'completed' }));
    await pendingMutation.promise;

    expect(onTasksChanged).not.toHaveBeenCalled();
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or conflicting focus params', async () => {
    window.location.hash = '/tasks?plan=not-a-uuid&group=unlinked';
    render(<MyTasks onTasksChanged={() => {}} />);
    expect(await screen.findByRole('tab', { name: 'Pending (4)' })).toBeDefined();
    expect(mocks.apiGet).toHaveBeenCalledWith('/user-tasks', { history: 1 });
  });

  it('ignores late previous-project page, status, and removal responses', async () => {
    const pageA = deferred<UserTaskListResponse>();
    const pageB = deferred<UserTaskListResponse>();
    mocks.apiGet.mockImplementation(() => projectState.current === 'project-a' ? pageA.promise : pageB.promise);
    const changed = vi.fn();
    window.location.hash = `/tasks?plan=${PLAN_ID}`;
    const { rerender, unmount } = render(<MyTasks onTasksChanged={changed} />);
    projectState.current = 'project-b';
    rerender(<MyTasks onTasksChanged={changed} />);
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/user-tasks', { history: 1 }));
    pageB.resolve(response([task({ id: 'b-task', title: 'Project B task', project_id: 'project-b-id' })]));
    expect(await screen.findByText('Project B task')).toBeDefined();
    pageA.resolve(response([task({ id: 'a-stale', title: 'Project A stale task' })]));
    await waitFor(() => expect(screen.queryByText('Project A stale task')).toBeNull());
    unmount();

    projectState.current = 'project-a';
    const lateStatus = deferred<UserTaskMutationResponse>();
    mocks.apiGet.mockResolvedValue(response());
    mocks.apiPost.mockReturnValue(lateStatus.promise);
    const statusView = render(<MyTasks onTasksChanged={changed} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete Zulu first' }));
    projectState.current = 'project-b';
    mocks.apiGet.mockResolvedValue(response([task({ id: 'b-current', title: 'Project B current' })]));
    statusView.rerender(<MyTasks onTasksChanged={changed} />);
    expect(await screen.findByText('Project B current')).toBeDefined();
    lateStatus.resolve(mutation({ ...planFirst, status: 'completed' }));
    await lateStatus.promise;
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText('Project B current')).toBeDefined();
    statusView.unmount();

    projectState.current = 'project-a';
    const lateRemoval = deferred<{ removed_count: number }>();
    mocks.apiGet.mockResolvedValue(response());
    mocks.apiPost.mockReturnValue(lateRemoval.promise);
    const removalView = render(<MyTasks onTasksChanged={changed} />);
    await screen.findByRole('tab', { name: /Pending/ });
    selectCompleted();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Completed task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    projectState.current = 'project-b';
    mocks.apiGet.mockResolvedValue(response([task({ id: 'b-latest', title: 'Project B latest' })]));
    removalView.rerender(<MyTasks onTasksChanged={changed} />);
    expect(await screen.findByText('Project B latest')).toBeDefined();
    lateRemoval.resolve({ removed_count: 1 });
    await lateRemoval.promise;
    await Promise.resolve();
    expect(screen.getByText('Project B latest')).toBeDefined();
    expect(changed).not.toHaveBeenCalled();
  });
});
