import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { IdeaRow } from '../../lib/types';

const mocks = vi.hoisted(() => {
  const push = vi.fn();
  return { apiGet: vi.fn(), apiPost: vi.fn(), setSetting: vi.fn(), push, toast: { push } };
});
const sortableMocks = vi.hoisted(() => ({
  useSortable: vi.fn((options: { id: string; disabled?: boolean }) => ({
    options,
    attributes: { role: 'button', tabIndex: 0 },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}));
const dndMocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../../lib/api', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: import('@dnd-kit/core').DndContextProps) => {
      dndMocks.dispatch.mockImplementation((event) => onDragEnd?.(event));
      return <>{children}</>;
    },
  };
});
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return { ...actual, useSortable: sortableMocks.useSortable };
});
vi.mock('../../shell/project', () => ({
  useProjects: () => ({ project: 'demo', projects: [], setProject: vi.fn() }),
}));
vi.mock('../../shell/settings', () => ({
  useSettings: () => ({
    settings: { 'roadmap.global_marker': '🧭' },
    setSetting: mocks.setSetting,
  }),
}));
vi.mock('../../shell/toast', () => ({ useToast: () => mocks.toast }));

import { Roadmap } from './Roadmap';

const row = (
  id: string,
  status: IdeaRow['status'],
  sortOrder: number,
  priority: IdeaRow['priority'] = 'someday',
  projectId: string | null = '11111111-2222-3333-4444-555555555555',
): IdeaRow => ({
  id,
  project_id: projectId,
  title: `idea ${id}`,
  detail: null,
  status,
  priority,
  sort_order: sortOrder,
  source: 'user',
  evidence: null,
  created_at: `2026-08-06T0${sortOrder / 1000}:00:00.000Z`,
  updated_at: '2026-08-06T00:00:00.000Z',
});

describe('Roadmap reorder persistence', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.setSetting.mockReset();
    mocks.push.mockReset();
    sortableMocks.useSortable.mockClear();
    dndMocks.dispatch.mockReset();
    mocks.apiGet.mockResolvedValue({ rows: [row('a', 'idea', 1000), row('x', 'planned', 1000)] });
    mocks.apiPost.mockResolvedValue({ idea: row('a', 'planned', 1000) });
    mocks.setSetting.mockResolvedValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keyboard moves persist the complete before/after target order atomically', async () => {
    render(<Roadmap />);
    const title = await screen.findByText('idea a');
    const card = title.closest('article');
    if (!card) throw new Error('idea card did not render');
    fireEvent.keyDown(card, { key: 'ArrowRight' });

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/reorder', {
      idea_id: 'a',
      status: 'planned',
      scope: 'both',
      include_closed: true,
      expected_ids: ['x'],
      ordered_ids: ['a', 'x'],
    }));
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/ideas/move', expect.anything());
  });

  it('renders click controls that use the same atomic cross-column move path', async () => {
    render(<Roadmap />);
    await screen.findByText('idea a');
    fireEvent.click(screen.getByRole('button', { name: 'Move idea a to planned' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/reorder', {
      idea_id: 'a',
      status: 'planned',
      scope: 'both',
      include_closed: true,
      expected_ids: ['x'],
      ordered_ids: ['a', 'x'],
    }));
  });

  it('sends only the active exact-project priority band for nudge moves', async () => {
    const project = '11111111-2222-3333-4444-555555555555';
    mocks.apiGet.mockResolvedValue({ rows: [
      row('active', 'idea', 1000, 'someday', project),
      row('same-band', 'planned', 1000, 'someday', project),
      row('other-priority', 'planned', -100, 'now', project),
      row('global-same-priority', 'planned', -200, 'someday', null),
    ] });
    render(<Roadmap />);
    const active = (await screen.findByText('idea active')).closest('article');
    if (!active) throw new Error('active card did not render');
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/reorder', {
      idea_id: 'active',
      status: 'planned',
      scope: 'both',
      include_closed: true,
      expected_ids: ['same-band'],
      ordered_ids: ['active', 'same-band'],
    }));
  });

  it('does not post same-status cross-priority or cross-project drags', async () => {
    const project = '11111111-2222-3333-4444-555555555555';
    mocks.apiGet.mockResolvedValue({ rows: [
      row('active', 'idea', 1000, 'someday', project),
      row('other-priority', 'idea', 1000, 'later', project),
      row('global-same-priority', 'idea', 1000, 'someday', null),
    ] });
    render(<Roadmap />);
    await screen.findByText('idea active');
    await act(async () => {
      dndMocks.dispatch({ active: { id: 'active' }, over: { id: 'other-priority' } });
      dndMocks.dispatch({ active: { id: 'active' }, over: { id: 'global-same-priority' } });
    });
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it('cross-status drag over another priority or project posts only the active band at index zero', async () => {
    const project = '11111111-2222-3333-4444-555555555555';
    for (const over of [
      row('other-priority', 'planned', -100, 'now', project),
      row('other-project-band', 'planned', -200, 'someday', null),
    ]) {
      cleanup();
      mocks.apiGet.mockReset();
      mocks.apiPost.mockReset();
      sortableMocks.useSortable.mockClear();
      dndMocks.dispatch.mockReset();
      mocks.apiGet.mockResolvedValue({ rows: [
        row('active', 'idea', 1000, 'someday', project),
        row('same-band', 'planned', 1000, 'someday', project),
        over,
      ] });
      mocks.apiPost.mockResolvedValue({});
      render(<Roadmap />);
      await screen.findByText('idea active');
      await act(async () => {
        dndMocks.dispatch({ active: { id: 'active' }, over: { id: over.id } });
      });
      await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/reorder', {
        idea_id: 'active',
        status: 'planned',
        scope: 'both',
        include_closed: true,
        expected_ids: ['same-band'],
        ordered_ids: ['active', 'same-band'],
      }));
    }
  });

  it('shows a compact card reference and copies the full idea UUID', async () => {
    const id = '5157349c-fa5c-4123-84f9-06fb82efe9cd';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mocks.apiGet.mockResolvedValue({ rows: [row(id, 'idea', 1000)] });

    render(<Roadmap />);
    const reference = await screen.findByRole('button', { name: `Copy full idea ID ${id}` });
    expect(reference.textContent).toBe('#5157349c');

    fireEvent.click(reference);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(id));
    expect(reference.textContent).toBe('#5157349c ✓');
  });

  it('finds cards by UUID, title, description, or evidence and clears with Escape', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const efficacy = {
      ...row('5157349c-fa5c-4123-84f9-06fb82efe9cd', 'idea', 1000),
      title: 'Memory-efficacy loop',
      detail: 'Recall and citation hit-rates per entry',
      evidence: 'Plan 22 and Plan 27',
    };
    const graph = {
      ...row('f0fe5528-7d04-4399-bd24-cfe286702454', 'planned', 2000),
      title: 'Graph freshness truth',
      detail: 'Separate code and database state',
    };
    const secondIdea = {
      ...row('b8d69b15-1044-49a0-aa97-d8d50852d280', 'idea', 2000),
      title: 'Curation loops second pass',
    };
    const dropped = {
      ...row('d557ba6f-1111-4222-8333-123456789abc', 'dropped', 1000),
      title: 'Archived launcher hardening',
    };
    mocks.apiGet.mockResolvedValue({ rows: [efficacy, secondIdea, graph, dropped] });

    render(<Roadmap />);
    const search = await screen.findByRole('searchbox', { name: 'Search roadmap' });

    fireEvent.change(search, { target: { value: 'citation hit-rates' } });
    expect(screen.getByText('Memory-efficacy loop')).toBeDefined();
    expect(screen.queryByText('Graph freshness truth')).toBeNull();
    expect(screen.getByText('1 match')).toBeDefined();
    expect(screen.getByTestId('column-count-idea').textContent).toBe('1');
    expect(screen.getByTestId('column-count-planned').textContent).toBe('0');
    expect(screen.getAllByText('no matches')).toHaveLength(3);

    const visibleCard = screen.getByText('Memory-efficacy loop').closest('article');
    if (!visibleCard) throw new Error('filtered idea card did not render');
    expect(visibleCard.getAttribute('role')).toBe('button');

    fireEvent.change(search, { target: { value: '#f0fe5528' } });
    expect(screen.getByText('Graph freshness truth')).toBeDefined();
    expect(screen.queryByText('Memory-efficacy loop')).toBeNull();

    fireEvent.change(search, { target: { value: graph.id } });
    expect(screen.getByText('Graph freshness truth')).toBeDefined();

    fireEvent.change(search, { target: { value: 'graph freshness' } });
    expect(screen.getByText('Graph freshness truth')).toBeDefined();

    fireEvent.change(search, { target: { value: 'plan 27' } });
    expect(screen.getByText('Memory-efficacy loop')).toBeDefined();

    fireEvent.change(search, { target: { value: 'archived launcher' } });
    expect(screen.getByText('Archived launcher hardening')).toBeDefined();
    expect(screen.getByRole('button', { name: /history/i }).getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(search, { key: 'Escape' });
    const restoredIdeas = within(screen.getByTestId('column-idea')).getAllByTestId('idea-card');
    expect(restoredIdeas.map((card) => card.dataset.ideaId)).toEqual([efficacy.id, secondIdea.id]);
    expect(restoredIdeas[0].getAttribute('role')).toBe('button');
    expect(screen.getByText('Graph freshness truth')).toBeDefined();
    expect(screen.queryByText('Archived launcher hardening')).toBeNull();
    expect(screen.queryByText(/matches?$/)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps cards draggable under a search, and moves them by the full list not the visible one', async () => {
    // Decision ad387d08 disabled drag while filtering, on the premise that
    // search reorders the board by relevance. It does not: matchesSearch is a
    // boolean predicate and columnCards applies the same comparator either
    // way, while onDragEnd reads `cards`, never `visibleCards`. Both halves
    // are asserted here, and each catches a different regression.
    const efficacy = {
      ...row('5157349c-fa5c-4123-84f9-06fb82efe9cd', 'idea', 1000),
      title: 'Memory-efficacy loop',
      detail: 'Recall and citation hit-rates per entry',
    };
    const hidden = {
      ...row('f0fe5528-7d04-4399-bd24-cfe286702454', 'planned', 2000),
      title: 'Graph freshness truth',
    };
    mocks.apiGet.mockResolvedValue({ rows: [efficacy, hidden] });

    render(<Roadmap />);
    const search = await screen.findByRole('searchbox', { name: 'Search roadmap' });
    fireEvent.change(search, { target: { value: 'citation hit-rates' } });
    expect(screen.queryByText('Graph freshness truth')).toBeNull();

    // Re-adding a dragDisabled guard withholds useSortable's attributes, so
    // this is the assertion that reddens on the regression. The payload check
    // below cannot see it: DndContext is mocked and dispatch reaches onDragEnd
    // directly, bypassing the sortable's disabled flag entirely.
    const visibleCard = screen.getByText('Memory-efficacy loop').closest('article');
    if (!visibleCard) throw new Error('filtered idea card did not render');
    expect(visibleCard.getAttribute('role')).toBe('button');

    await act(async () => {
      dndMocks.dispatch({ active: { id: efficacy.id }, over: { id: 'planned' } });
    });

    // `hidden` is filtered out of the board yet must appear in BOTH id lists:
    // the atomic reorder describes the whole target band, and a payload
    // computed from visibleCards would drop it and reorder the real column.
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/reorder', {
      idea_id: efficacy.id,
      status: 'planned',
      scope: 'both',
      include_closed: true,
      expected_ids: [hidden.id],
      ordered_ids: [efficacy.id, hidden.id],
    }));
  });

  it('a failed move invalidates queued optimistic payloads and awaits reconciliation', async () => {
    let rejectFirstPost: ((reason?: unknown) => void) | undefined;
    let resolveReload: ((value: { rows: IdeaRow[] }) => void) | undefined;
    const initial = [row('a', 'idea', 1000), row('x', 'planned', 1000)];
    const firstPost = new Promise<never>((_resolve, reject) => { rejectFirstPost = reject; });
    const reload = new Promise<{ rows: IdeaRow[] }>((resolve) => { resolveReload = resolve; });
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValueOnce({ rows: initial }).mockReturnValueOnce(reload);
    mocks.apiPost.mockReset();
    mocks.apiPost.mockReturnValueOnce(firstPost).mockResolvedValue({ idea: row('x', 'building', 1000) });

    render(<Roadmap />);
    const a = (await screen.findByText('idea a')).closest('article');
    const x = screen.getByText('idea x').closest('article');
    if (!a || !x) throw new Error('roadmap cards did not render');

    fireEvent.keyDown(a, { key: 'ArrowRight' });
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(x, { key: 'ArrowRight' });
    if (!rejectFirstPost) throw new Error('first reorder did not start');
    rejectFirstPost(new Error('first move rejected'));

    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    if (!resolveReload) throw new Error('failure reload did not start');
    resolveReload({ rows: initial });

    await waitFor(() => {
      expect(within(screen.getByTestId('column-idea')).getByText('idea a')).toBeDefined();
      expect(within(screen.getByTestId('column-planned')).getByText('idea x')).toBeDefined();
    });
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it('opens edit mode from the card and reloads after saving changed fields', async () => {
    render(<Roadmap />);
    await screen.findByText('idea a');
    fireEvent.click(screen.getByRole('button', { name: 'Edit idea a' }));

    const title = screen.getByPlaceholderText("One line — what's the idea?");
    if (!(title instanceof HTMLInputElement)) throw new Error('edit title control is not an input');
    expect(title.value).toBe('idea a');
    fireEvent.change(title, { target: { value: 'idea a edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/update', {
      idea_id: 'a', title: 'idea a edited',
    }));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
  });

  it('moves a priority click immediately to the top of its exact band and reloads on rejection', async () => {
    let rejectMove: ((reason?: unknown) => void) | undefined;
    const move = new Promise<never>((_resolve, reject) => { rejectMove = reject; });
    const project = '11111111-2222-3333-4444-555555555555';
    const initial = [
      row('anchor-a', 'idea', 1000, 'now', project),
      row('anchor-b', 'idea', 2000, 'now', project),
      row('moved', 'idea', 9000, 'next', project),
      row('global-now', 'idea', -100, 'now', null),
    ];
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValueOnce({ rows: initial }).mockResolvedValueOnce({ rows: initial });
    mocks.apiPost.mockReset();
    mocks.apiPost.mockReturnValueOnce(move);

    render(<Roadmap />);
    const movedTitle = await screen.findByText('idea moved');
    const movedCard = movedTitle.closest('article');
    if (!movedCard) throw new Error('priority target card did not render');
    fireEvent.click(within(movedCard).getByTestId('priority-chip'));

    const ids = within(screen.getByTestId('column-idea')).getAllByTestId('idea-card')
      .map((element) => element.dataset.ideaId);
    expect(ids).toEqual(['moved', 'anchor-a', 'anchor-b', 'global-now']);
    expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/move', { idea_id: 'moved', priority: 'now' });
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/ideas/reorder', expect.anything());

    if (!rejectMove) throw new Error('priority move did not start');
    rejectMove(new Error('priority rejected'));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
  });

  it('sorts dropped history canonically instead of trusting response order', async () => {
    const project = '11111111-2222-3333-4444-555555555555';
    mocks.apiGet.mockResolvedValue({ rows: [
      { ...row('someday', 'dropped', 1, 'someday', project), title: 'history someday' },
      { ...row('global-now', 'dropped', -100, 'now', null), title: 'history global now' },
      { ...row('later', 'dropped', 1, 'later', project), title: 'history later' },
      { ...row('project-now-b', 'dropped', 1000, 'now', project), title: 'history project now b', created_at: '2026-08-06T10:00:00.000Z' },
      { ...row('next', 'dropped', 1, 'next', project), title: 'history next' },
      { ...row('project-now-a', 'dropped', 1000, 'now', project), title: 'history project now a', created_at: '2026-08-06T09:00:00.000Z' },
    ] });
    render(<Roadmap />);
    await screen.findByRole('button', { name: /history/i });
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    const history = screen.getByRole('list');
    expect(within(history).getAllByRole('listitem').map((item) => item.textContent?.trim())).toEqual([
      '·history project now a',
      '·history project now b',
      '·history global now',
      '·history next',
      '·history later',
      '·history someday',
    ]);
  });

  it('reloads and renders the backend-reseated band after an edit-modal priority change', async () => {
    const project = '11111111-2222-3333-4444-555555555555';
    const edited = { ...row('edited', 'idea', 8000, 'later', project), title: 'edited card' };
    const anchor = { ...row('anchor', 'idea', 1000, 'now', project), title: 'now anchor' };
    const reloaded = [{ ...edited, priority: 'now' as const, sort_order: 0 }, anchor];
    mocks.apiGet.mockReset();
    mocks.apiGet.mockResolvedValueOnce({ rows: [anchor, edited] }).mockResolvedValueOnce({ rows: reloaded });
    mocks.apiPost.mockResolvedValue({});

    render(<Roadmap />);
    await screen.findByText('edited card');
    fireEvent.click(screen.getByRole('button', { name: 'Edit edited card' }));
    const nowButtons = screen.getAllByRole('button', { name: 'now' });
    fireEvent.click(nowButtons[nowButtons.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/update', {
      idea_id: 'edited', priority: 'now',
    }));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByTestId('column-idea')).getAllByTestId('idea-card')
      .map((element) => element.dataset.ideaId)).toEqual(['edited', 'anchor']));
  });

  it('renders the configured marker at both Roadmap sites and saves a change', async () => {
    mocks.apiGet.mockResolvedValue({ rows: [{ ...row('g', 'idea', 1000), project_id: null }] });
    render(<Roadmap />);
    await screen.findByText('idea g');
    expect(screen.getByRole('button', { name: 'global 🧭' })).toBeTruthy();
    expect(screen.getByLabelText('global board').textContent).toBe('🧭');

    fireEvent.click(screen.getByRole('button', { name: 'Change the global-board marker' }));
    const markerInput = screen.getByRole('textbox', { name: 'Global-board marker' });
    if (!(markerInput instanceof HTMLInputElement)) throw new Error('marker control is not an input');
    fireEvent.change(markerInput, { target: { value: '⭐' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(mocks.setSetting).toHaveBeenCalledWith('roadmap.global_marker', '⭐'));
  });
});
