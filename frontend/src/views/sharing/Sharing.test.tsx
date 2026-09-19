import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const projectState = vi.hoisted(() => ({ current: 'product-b' }));
vi.mock('../../lib/api', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }));
vi.mock('../../shell/project', () => ({
  useProjects: () => ({ project: projectState.current, projects: [{ slug: 'product-a' }, { slug: 'product-b' }] }),
}));

import { Sharing } from './Sharing';

const inbound = {
  id: '11111111-1111-4111-8111-111111111111', direction: 'in', kind: 'decision', status: 'active',
  source_slug: 'product-a', current_source_slug: 'product-a', target_slug: 'product-b',
  headline: 'shared ruling', body: 'snapshot', detail: 'security', note: null,
  fields: { source: 'user-approved', confidence: '0.90' },
  live: { status: 'ok', detail: null, note: null }, created_at: '2026-08-18T12:00:00.000Z',
  revoked_at: null, revoked_reason: null, link_state: 'linked',
};
const maxUiRefs: Array<{ kind: 'file'; path: string }> = Array.from({ length: 8 }, (_, i) => ({
  kind: 'file', path: `docs/${i}-${'r'.repeat(505)}`,
}));
const operatorRows = [
  inbound,
  { ...inbound, id: '12111111-1111-4111-8111-111111111111', kind: 'handoff',
    headline: 'shared handoff', fields: { author_agent: 'agent@test', refs: maxUiRefs } },
  { ...inbound, id: '13111111-1111-4111-8111-111111111111', kind: 'idea',
    headline: 'shared idea', fields: { priority: 'high', status: 'open' } },
  { ...inbound, id: '14111111-1111-4111-8111-111111111111', kind: 'doc',
    headline: 'shared doc', fields: { doc_kind: 'spec', heading_trail: 'Custody > Boundary' } },
];
const firstEvent = {
  id: '21111111-1111-4111-8111-111111111111', event: 'grant', source_slug: 'product-a',
  target_slug: 'product-b', artifact_kind: 'decision', headline: 'first audit event',
  actor_surface: 'cli', note: null, created_at: '2026-08-18T12:00:00.000Z',
};
const secondEvent = { ...firstEvent, id: '31111111-1111-4111-8111-111111111111', headline: 'second-page event' };
type TestLinkState = { source_slug: string; current_source_slug: string | null; state: string; detail: string };
type TestCandidate = { id: string; headline: string; detail: string };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => { throw new Error('deferred resolved before initialization'); };
  let reject = (_reason: unknown): void => { throw new Error('deferred rejected before initialization'); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('Sharing operator states and pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.current = 'product-b';
    mocks.apiPost.mockResolvedValue({ message: 'ok' });
    mocks.apiGet.mockImplementation((path: string, params?: Record<string, string>) => {
      if (path === '/shares') return Promise.resolve({
        rows: operatorRows, declared_links: ['product-a', 'old-product'],
        link_states: [
          { source_slug: 'product-a', current_source_slug: 'product-a', state: 'linked', detail: 'both runtime link and grant source agree' },
          { source_slug: 'pending-product', current_source_slug: 'pending-product', state: 'pending', detail: 'run: mai link product-b --with pending-product' },
          { source_slug: 'old-product', current_source_slug: 'renamed-product', state: 'dark', detail: "source renamed to 'renamed-product' — references are dark" },
          { source_slug: 'historical-product', current_source_slug: 'current-product', state: 'linked', detail: "relinked to renamed source 'current-product' (grant-time slug 'historical-product')" },
          { source_slug: 'deleted-product', current_source_slug: null, state: 'dark', detail: 'source renamed or deleted — references are dark' },
        ],
      });
      if (path === '/share-events' && params?.cursor === 'next-1') {
        return Promise.resolve({ rows: [secondEvent], next_cursor: null });
      }
      if (path === '/share-events') return Promise.resolve({ rows: [firstEvent], next_cursor: 'next-1' });
      return Promise.resolve({ rows: [] });
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders linked, pending and dark states plus the inbound grant date', async () => {
    render(<Sharing />);
    expect(await screen.findByText(/both runtime link and grant source agree/)).toBeDefined();
    expect(screen.getByText(/run: mai link product-b --with pending-product/)).toBeDefined();
    expect(screen.getByText(/source renamed to 'renamed-product'/)).toBeDefined();
    expect(screen.getByText(/relinked to renamed source 'current-product'/)).toBeDefined();
    expect(screen.getByText(/source renamed or deleted/)).toBeDefined();
    expect(screen.getAllByText('granted 2026-08-18')).toHaveLength(4);
  });

  it('rejects an invalid kind value at the dashboard select boundary', async () => {
    render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    const kindSelect = screen.getAllByRole<HTMLSelectElement>('combobox')[0];
    expect(kindSelect.value).toBe('decision');
    fireEvent.change(kindSelect, { target: { value: 'not-a-share-kind' } });
    expect(kindSelect.value).toBe('decision');
  });

  it('renders every kind-specific operator snapshot field, including structured handoff refs', async () => {
    render(<Sharing />);
    for (const button of await screen.findAllByRole('button', { name: 'view snapshot' })) fireEvent.click(button);
    expect(screen.getByText(/source: user-approved/)).toBeDefined();
    expect(screen.getByText(/confidence: 0.90/)).toBeDefined();
    expect(screen.getByText(/author_agent: agent@test/)).toBeDefined();
    expect([...document.querySelectorAll('pre')].some((el) =>
      el.textContent?.includes(`refs: ${JSON.stringify(maxUiRefs)}`)
    )).toBe(true);
    expect(screen.getByText(/priority: high/)).toBeDefined();
    expect(screen.getByText(/status: open/)).toBeDefined();
    expect(screen.getByText(/doc_kind: spec/)).toBeDefined();
    expect(screen.getByText(/heading_trail: Custody > Boundary/)).toBeDefined();
  });

  it('loads the next stable audit page without replacing the first page', async () => {
    render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Audit/ }));
    expect(await screen.findByText('first audit event')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Load more audit events' }));
    expect(await screen.findByText('second-page event')).toBeDefined();
    expect(screen.getByText('first audit event')).toBeDefined();
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/share-events', { cursor: 'next-1' }));
  });

  it('ignores a late previous-project list response and exposes no stale revoke row', async () => {
    const aShares = deferred<{ rows: typeof operatorRows; declared_links: string[]; link_states: TestLinkState[] }>();
    const aEvents = deferred<{ rows: Array<typeof firstEvent>; next_cursor: string | null }>();
    const bShares = deferred<{ rows: typeof operatorRows; declared_links: string[]; link_states: TestLinkState[] }>();
    const bEvents = deferred<{ rows: Array<typeof firstEvent>; next_cursor: string | null }>();
    projectState.current = 'product-a';
    mocks.apiGet.mockImplementation((path: string) => {
      const a = projectState.current === 'product-a';
      if (path === '/shares') return a ? aShares.promise : bShares.promise;
      if (path === '/share-events') return a ? aEvents.promise : bEvents.promise;
      return Promise.resolve({ rows: [] });
    });
    const { rerender } = render(<Sharing />);
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    projectState.current = 'product-b';
    rerender(<Sharing />);
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(4));
    bShares.resolve({ rows: [{ ...inbound, headline: 'B current row' }], declared_links: [], link_states: [] });
    bEvents.resolve({ rows: [], next_cursor: null });
    expect(await screen.findByText('B current row')).toBeDefined();
    aShares.resolve({ rows: [{ ...inbound, direction: 'out', headline: 'A stale revocable row' }], declared_links: [], link_states: [] });
    aEvents.resolve({ rows: [], next_cursor: null });
    await waitFor(() => expect(screen.queryByText('A stale revocable row')).toBeNull());
    expect(screen.getByText('B current row')).toBeDefined();
  });

  it('ignores a late previous-project audit continuation', async () => {
    const lateA = deferred<{ rows: Array<typeof firstEvent>; next_cursor: string | null }>();
    projectState.current = 'product-a';
    mocks.apiGet.mockImplementation((path: string, params?: Record<string, string>) => {
      if (path === '/shares') return Promise.resolve({ rows: [], declared_links: [], link_states: [] });
      if (path === '/share-events' && params?.cursor === 'a-next') return lateA.promise;
      if (path === '/share-events') return Promise.resolve({
        rows: [{ ...firstEvent, headline: `${projectState.current} initial event` }],
        next_cursor: projectState.current === 'product-a' ? 'a-next' : null,
      });
      return Promise.resolve({ rows: [] });
    });
    const { rerender } = render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Audit/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more audit events' }));
    projectState.current = 'product-b';
    rerender(<Sharing />);
    expect(await screen.findByText('product-b initial event')).toBeDefined();
    lateA.resolve({ rows: [{ ...secondEvent, headline: 'A stale audit page' }], next_cursor: null });
    await waitFor(() => expect(screen.queryByText('A stale audit page')).toBeNull());
  });

  it('hides the grant picker synchronously on a project switch, then remounts it empty', async () => {
    // R11: "a project switch hides old data/actions synchronously and resets
    // the grant picker". The synchronous HIDE is the falsifiable half — the
    // reset follows from the panel unmounting while the new project loads.
    projectState.current = 'product-a';
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/shares') return Promise.resolve({ rows: [], declared_links: [], link_states: [] });
      if (path === '/share-events') return Promise.resolve({ rows: [], next_cursor: null });
      if (path === '/share-candidates') {
        return Promise.resolve({ rows: [{ id: 'a-id', headline: 'A candidate', detail: 'decision' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { rerender } = render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    const pickerA = await screen.findByPlaceholderText('search artifacts…');
    fireEvent.change(pickerA, { target: { value: 'candidate' } });
    expect(await screen.findByText(/A candidate/)).toBeDefined();

    // The switch must hide the picker AND its results in the same tick — no
    // window in which product-a's actions are live under product-b.
    projectState.current = 'product-b';
    rerender(<Sharing />);
    expect(screen.queryByPlaceholderText('search artifacts…')).toBeNull();
    expect(screen.queryByText(/A candidate/)).toBeNull();

    // …and it comes back empty for the new project.
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    const pickerB = await screen.findByPlaceholderText('search artifacts…');
    expect(pickerB).toHaveProperty('value', '');
    expect(screen.queryByText(/A candidate/)).toBeNull();
  });

  it('ignores an out-of-order candidate response within one project', async () => {
    // The generation guard in GrantForm, exercised WITHOUT a project switch —
    // a switch unmounts the whole panel, which would mask the guard entirely.
    const slow = deferred<{ rows: TestCandidate[] }>();
    const fast = deferred<{ rows: TestCandidate[] }>();
    let call = 0;
    projectState.current = 'product-b';
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/shares') return Promise.resolve({ rows: [], declared_links: [], link_states: [] });
      if (path === '/share-events') return Promise.resolve({ rows: [], next_cursor: null });
      if (path === '/share-candidates') { call += 1; return call === 1 ? slow.promise : fast.promise; }
      return Promise.resolve({ rows: [] });
    });
    render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    const picker = await screen.findByPlaceholderText('search artifacts…');
    fireEvent.change(picker, { target: { value: 'first' } });
    await waitFor(() => expect(call).toBe(1));
    fireEvent.change(picker, { target: { value: 'second' } });
    await waitFor(() => expect(call).toBe(2));

    fast.resolve({ rows: [{ id: 'f', headline: 'SECOND result', detail: 'decision' }] });
    expect(await screen.findByText(/SECOND result/)).toBeDefined();
    // The superseded first query resolves LAST and must not overwrite.
    slow.resolve({ rows: [{ id: 's', headline: 'FIRST stale result', detail: 'decision' }] });
    await waitFor(() => expect(screen.queryByText(/SECOND result/)).not.toBeNull());
    expect(screen.queryByText(/FIRST stale result/)).toBeNull();
  });

  it('binds a late grant success to its originating project and does not reload the new project', async () => {
    const lateGrant = deferred<{ message: string }>();
    const postProjects: string[] = [];
    projectState.current = 'product-a';
    mocks.apiPost.mockImplementation(() => {
      postProjects.push(projectState.current);
      return lateGrant.promise;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/shares') return Promise.resolve({ rows: [], declared_links: [], link_states: [] });
      if (path === '/share-events') return Promise.resolve({ rows: [], next_cursor: null });
      if (path === '/share-candidates') {
        return Promise.resolve({ rows: [{ id: 'a-grant', headline: 'A grant candidate', detail: 'decision' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { rerender } = render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    fireEvent.change(screen.getByPlaceholderText('search artifacts…'), { target: { value: 'candidate' } });
    fireEvent.click(await screen.findByRole('button', { name: /A grant candidate/ }));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'product-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'share' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(postProjects).toEqual(['product-a']);

    projectState.current = 'product-b';
    rerender(<Sharing />);
    expect(await screen.findByText(/Grant a new share \(source: product-b\)/)).toBeDefined();
    const bShareLoads = mocks.apiGet.mock.calls.filter(([path]) => path === '/shares').length;
    lateGrant.resolve({ message: 'A grant completed late' });
    await lateGrant.promise;
    await Promise.resolve();
    expect(mocks.apiGet.mock.calls.filter(([path]) => path === '/shares')).toHaveLength(bShareLoads);
    expect(screen.queryByText(/A grant candidate/)).toBeNull();
    expect(screen.queryByText(/A grant completed late/)).toBeNull();
  });

  it('binds a late revoke failure to its originating project and exposes no stale action or error', async () => {
    const lateRevoke = deferred<{ message: string }>();
    const postProjects: string[] = [];
    const aOutbound = { ...inbound, direction: 'out', source_slug: 'product-a',
      target_slug: 'product-b', headline: 'A revocable row' };
    projectState.current = 'product-a';
    mocks.apiPost.mockImplementation(() => {
      postProjects.push(projectState.current);
      return lateRevoke.promise;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/shares') return Promise.resolve({
        rows: projectState.current === 'product-a' ? [aOutbound] : [{ ...inbound, headline: 'B current row' }],
        declared_links: [], link_states: [],
      });
      if (path === '/share-events') return Promise.resolve({ rows: [], next_cursor: null });
      return Promise.resolve({ rows: [] });
    });
    vi.spyOn(window, 'prompt').mockReturnValue('A revoke reason');
    const { rerender } = render(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Outbound/ }));
    expect(await screen.findByText('A revocable row')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'revoke' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    expect(postProjects).toEqual(['product-a']);

    projectState.current = 'product-b';
    rerender(<Sharing />);
    fireEvent.click(await screen.findByRole('button', { name: /Inbound/ }));
    expect(await screen.findByText('B current row')).toBeDefined();
    const bShareLoads = mocks.apiGet.mock.calls.filter(([path]) => path === '/shares').length;
    lateRevoke.reject(new Error('A revoke failure'));
    await lateRevoke.promise.catch(() => {});
    await Promise.resolve();
    expect(mocks.apiGet.mock.calls.filter(([path]) => path === '/shares')).toHaveLength(bShareLoads);
    expect(screen.queryByText('A revocable row')).toBeNull();
    expect(screen.queryByText(/A revoke failure/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'revoke' })).toBeNull();
  });
});
