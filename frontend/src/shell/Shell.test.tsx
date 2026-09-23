import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));
const projectState = vi.hoisted(() => ({ current: 'project-a' }));
vi.mock('../lib/api', () => ({ apiGet: mocks.apiGet }));
vi.mock('./project', () => ({
  ProjectProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useProjects: () => ({ project: projectState.current, projects: [], setProject: vi.fn() }),
}));
vi.mock('./toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./settings', () => ({ SettingsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./NoteModal', () => ({ NoteModal: () => <div>Note modal</div> }));
vi.mock('../views/home/Home', () => ({ Home: () => <div>Home</div> }));
vi.mock('../views/review/Review', () => ({ Review: () => <div>Review</div> }));
vi.mock('../views/graph/Graph', () => ({ Graph: () => <div>Graph</div> }));
vi.mock('../views/search/Search', () => ({ Search: () => <div>Search</div> }));
vi.mock('../views/timeline/Timeline', () => ({ Timeline: () => <div>Timeline</div> }));
vi.mock('../views/sessions/Sessions', () => ({ Sessions: () => <div>Sessions</div> }));
vi.mock('../views/topics/Topics', () => ({ Topics: () => <div>Topics</div> }));
vi.mock('../views/roadmap/Roadmap', () => ({ Roadmap: () => <div>Roadmap</div> }));
vi.mock('../views/sharing/Sharing', () => ({ Sharing: () => <div>Sharing</div> }));
vi.mock('../views/settings/Providers', () => ({ Providers: () => <div>Providers & Connections</div> }));
vi.mock('../views/profile/Profile', () => ({ Profile: () => <div>Profile</div> }));
vi.mock('../views/tasks/MyTasks', () => ({
  MyTasks: ({ onTasksChanged }: { onTasksChanged: () => void }) => (
    <button type="button" onClick={onTasksChanged}>Trigger task refresh</button>
  ),
}));

import { Shell } from './Shell';

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error('deferred not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function taskSummary(count: number) {
  return { pending_count: count, blocking_count: count, follow_up_count: 0, rows: [], groups: [] };
}

function userTaskCalls() {
  return mocks.apiGet.mock.calls.filter(([path]) => path === '/user-tasks');
}

describe('Shell task badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.current = 'project-a';
    window.location.hash = '/tasks';
    mocks.apiGet.mockImplementation((path: string) => Promise.resolve(
      path === '/user-tasks' ? taskSummary(100) : { rows: [] }
    ));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls only the summary task endpoint, caps 100, and refreshes immediately after mutation', async () => {
    render(<Shell />);
    expect(await screen.findByTestId('tasks-badge')).toHaveProperty('textContent', '99+');
    expect(userTaskCalls()).toEqual([['/user-tasks', { summary: 1 }]]);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger task refresh' }));
    await waitFor(() => expect(userTaskCalls()).toHaveLength(2));
    expect(userTaskCalls().every(([, params]) => params?.summary === 1)).toBe(true);
  });

  it('routes task hashes with a plan query to My Tasks', async () => {
    window.location.hash = '/tasks?plan=11111111-1111-4111-8111-111111111111';
    render(<Shell />);
    expect(await screen.findByRole('button', { name: 'Trigger task refresh' })).toBeDefined();
    expect(window.location.hash).toContain('?plan=11111111-1111-4111-8111-111111111111');
  });

  it('polls the task summary every 60 seconds', async () => {
    vi.useFakeTimers();
    render(<Shell />);
    await act(async () => { await Promise.resolve(); });
    expect(userTaskCalls()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(userTaskCalls()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(userTaskCalls()).toHaveLength(2);
  });

  it('clears the prior badge synchronously when projects switch', async () => {
    const b = deferred<ReturnType<typeof taskSummary>>();
    mocks.apiGet.mockImplementation((path: string) => {
      if (path !== '/user-tasks') return Promise.resolve({ rows: [] });
      return projectState.current === 'project-a' ? Promise.resolve(taskSummary(7)) : b.promise;
    });
    const { rerender } = render(<Shell />);
    expect(await screen.findByTestId('tasks-badge')).toHaveProperty('textContent', '7');
    projectState.current = 'project-b';
    rerender(<Shell />);
    expect(screen.queryByTestId('tasks-badge')).toBeNull();
    b.resolve(taskSummary(2));
    expect(await screen.findByTestId('tasks-badge')).toHaveProperty('textContent', '2');
  });

  it('does not let a late project-A summary overwrite project B', async () => {
    const a = deferred<ReturnType<typeof taskSummary>>();
    const b = deferred<ReturnType<typeof taskSummary>>();
    mocks.apiGet.mockImplementation((path: string) => {
      if (path !== '/user-tasks') return Promise.resolve({ rows: [] });
      return projectState.current === 'project-a' ? a.promise : b.promise;
    });
    const { rerender } = render(<Shell />);
    await waitFor(() => expect(userTaskCalls()).toHaveLength(1));
    projectState.current = 'project-b';
    rerender(<Shell />);
    await waitFor(() => expect(userTaskCalls()).toHaveLength(2));
    b.resolve(taskSummary(4));
    expect(await screen.findByTestId('tasks-badge')).toHaveProperty('textContent', '4');
    a.resolve(taskSummary(88));
    await a.promise;
    await Promise.resolve();
    expect(screen.getByTestId('tasks-badge')).toHaveProperty('textContent', '4');
  });
});

it('opens Providers & Connections from Settings and retains the project',async()=>{
  projectState.current='project-a';mocks.apiGet.mockResolvedValue({rows:[],pending_count:0});window.location.hash='/home';render(<Shell/>);
  fireEvent.click(screen.getByRole('button',{name:'Settings'}));
  expect(await screen.findByText('Providers & Connections')).toBeDefined();expect(window.location.hash).toBe('#/settings');expect(projectState.current).toBe('project-a');cleanup();
});
