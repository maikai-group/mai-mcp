import { describe, expect, it } from 'vitest';
import {
  PRIORITY_RANK,
  WORKING_COLUMNS,
  applyPriorityChange,
  applyReorder,
  columnCards,
  dropTargetIndex,
  priorityBandCards,
} from './board';
import type { IdeaPriority, IdeaRow, IdeaStatus } from '../../lib/types';

const card = (
  id: string,
  status: IdeaStatus,
  sort_order: number,
  priority: IdeaPriority = 'someday',
  project_id: string | null = 'p1',
  created_at = '2026-08-06T00:00:00.000Z',
): IdeaRow => ({
  id, project_id, title: `idea ${id}`, detail: null, status, priority, sort_order,
  source: 'user', evidence: null, created_at, updated_at: created_at,
});

describe('roadmap priority comparator', () => {
  it('defines the canonical rank and all 24 directed pairwise comparisons', () => {
    const priorities: IdeaPriority[] = ['now', 'next', 'later', 'someday'];
    expect(PRIORITY_RANK).toEqual({ now: 0, next: 1, later: 2, someday: 3 });
    let comparisons = 0;
    for (const projectId of ['p1', null] as const) {
      for (let left = 0; left < priorities.length; left += 1) {
        for (let right = left + 1; right < priorities.length; right += 1) {
          const input = [
            card(`right-${projectId}-${right}`, 'idea', -100, priorities[right], projectId),
            card(`left-${projectId}-${left}`, 'idea', 9000, priorities[left], projectId),
          ];
          expect(columnCards(input, 'idea').map((item) => item.priority))
            .toEqual([priorities[left], priorities[right]]);
          expect(columnCards([...input].reverse(), 'idea').map((item) => item.priority))
            .toEqual([priorities[left], priorities[right]]);
          comparisons += 2;
        }
      }
    }
    expect(comparisons).toBe(24);
  });

  it('orders selected-project before global, then rank, creation, and id inside a priority', () => {
    const input = [
      card('global', 'idea', -100, 'now', null, '2026-08-06T01:00:00.000Z'),
      card('young', 'idea', 1000, 'now', 'p1', '2026-08-06T10:00:00.000Z'),
      card('z-id', 'idea', 1000, 'now', 'p1', '2026-08-06T09:00:00.000Z'),
      card('a-id', 'idea', 1000, 'now', 'p1', '2026-08-06T09:00:00.000Z'),
      card('first-rank', 'idea', 10, 'now', 'p1', '2026-08-06T11:00:00.000Z'),
    ];
    expect(columnCards(input, 'idea').map((item) => item.id)).toEqual([
      'first-rank', 'a-id', 'z-id', 'young', 'global',
    ]);
  });

  it('does not mutate the input and handles an empty column', () => {
    const input = [card('z', 'idea', 2000), card('y', 'idea', 1000)];
    columnCards(input, 'idea');
    expect(input.map((item) => item.id)).toEqual(['z', 'y']);
    expect(columnCards(input, 'building')).toEqual([]);
  });
});

describe('priorityBandCards and applyPriorityChange', () => {
  it('filters one exact project/status/priority band', () => {
    const input = [
      card('wanted-b', 'planned', 2000, 'next', 'p1'),
      card('wanted-a', 'planned', 1000, 'next', 'p1'),
      card('other-priority', 'planned', 0, 'later', 'p1'),
      card('global', 'planned', 0, 'next', null),
      card('other-status', 'idea', 0, 'next', 'p1'),
    ];
    expect(priorityBandCards(input, 'planned', 'next', 'p1').map((item) => item.id))
      .toEqual(['wanted-a', 'wanted-b']);
  });

  it('moves to the top of only the destination exact-project band without renumbering others', () => {
    const input = [
      card('moved', 'idea', 7000, 'someday', 'p1'),
      card('project-next-a', 'idea', 1000, 'next', 'p1'),
      card('project-next-b', 'idea', 2000, 'next', 'p1'),
      card('global-next', 'idea', -500, 'next', null),
      card('other-priority', 'idea', 17, 'later', 'p1'),
    ];
    const next = applyPriorityChange(input, 'moved', 'next');
    expect(next).not.toBe(input);
    expect(priorityBandCards(next, 'idea', 'next', 'p1').map((item) => item.id))
      .toEqual(['moved', 'project-next-a', 'project-next-b']);
    expect(next.find((item) => item.id === 'moved')).toMatchObject({ priority: 'next', sort_order: 0 });
    expect(next.find((item) => item.id === 'global-next')?.sort_order).toBe(-500);
    expect(next.find((item) => item.id === 'other-priority')?.sort_order).toBe(17);
    expect(input.find((item) => item.id === 'moved')).toMatchObject({ priority: 'someday', sort_order: 7000 });
  });

  it('uses rank 1000 for an empty band and returns the original array for unknown/unchanged cards', () => {
    const input = [card('moved', 'idea', 7000, 'someday', 'p1')];
    expect(applyPriorityChange(input, 'moved', 'now').find((item) => item.id === 'moved')?.sort_order).toBe(1000);
    expect(applyPriorityChange(input, 'missing', 'now')).toBe(input);
    expect(applyPriorityChange(input, 'moved', 'someday')).toBe(input);
  });
});

describe('exact-band drag and reorder helpers', () => {
  const input: IdeaRow[] = [
    card('a', 'idea', 1000, 'now', 'p1'),
    card('b', 'idea', 2000, 'now', 'p1'),
    card('c', 'idea', 3000, 'now', 'p1'),
    card('other-priority', 'idea', 7, 'later', 'p1'),
    card('global-now', 'idea', 9, 'now', null),
    card('target-a', 'planned', 1000, 'now', 'p1'),
    card('target-b', 'planned', 2000, 'now', 'p1'),
    card('target-later', 'planned', -10, 'later', 'p1'),
    card('target-global', 'planned', -20, 'now', null),
  ];

  it('moves down and up inside one tied or ranked band', () => {
    const down = dropTargetIndex(input, 'idea', 'a', 'b');
    const up = dropTargetIndex(input, 'idea', 'c', 'b');
    expect(priorityBandCards(applyReorder(input, 'a', 'idea', down), 'idea', 'now', 'p1').map((item) => item.id))
      .toEqual(['b', 'a', 'c']);
    expect(priorityBandCards(applyReorder(input, 'c', 'idea', up), 'idea', 'now', 'p1').map((item) => item.id))
      .toEqual(['a', 'c', 'b']);

    const tied = [
      card('tied-a', 'idea', 1000, 'now', 'p1', '2026-08-06T09:00:00.000Z'),
      card('tied-b', 'idea', 1000, 'now', 'p1', '2026-08-06T10:00:00.000Z'),
      card('tied-c', 'idea', 1000, 'now', 'p1', '2026-08-06T11:00:00.000Z'),
    ];
    expect(priorityBandCards(
      applyReorder(tied, 'tied-a', 'idea', dropTargetIndex(tied, 'idea', 'tied-a', 'tied-b')),
      'idea', 'now', 'p1',
    ).map((item) => item.id)).toEqual(['tied-b', 'tied-a', 'tied-c']);
  });

  it('inserts cross-status before a same-band card and at top for a different-band/card or column target', () => {
    const sameBandIndex = dropTargetIndex(input, 'planned', 'a', 'target-b');
    expect(sameBandIndex).toBe(1);
    expect(priorityBandCards(applyReorder(input, 'a', 'planned', sameBandIndex), 'planned', 'now', 'p1')
      .map((item) => item.id)).toEqual(['target-a', 'a', 'target-b']);

    for (const overId of ['target-later', 'target-global', 'planned']) {
      const index = dropTargetIndex(input, 'planned', 'a', overId);
      expect(index).toBe(0);
      const next = applyReorder(input, 'a', 'planned', index);
      expect(priorityBandCards(next, 'planned', 'now', 'p1').map((item) => item.id))
        .toEqual(['a', 'target-a', 'target-b']);
    }
  });

  it('makes same-status cross-priority and cross-project targets no-ops', () => {
    for (const overId of ['other-priority', 'global-now']) {
      const index = dropTargetIndex(input, 'idea', 'a', overId);
      expect(index).toBe(-1);
      expect(applyReorder(input, 'a', 'idea', index)).toBe(input);
    }
  });

  it('handles an empty target band and preserves every other band rank/project/priority', () => {
    const before = new Map(input.filter((item) => item.priority !== 'now' || item.project_id !== 'p1')
      .map((item) => [item.id, item]));
    const next = applyReorder(input, 'a', 'shipped', 0);
    expect(priorityBandCards(next, 'shipped', 'now', 'p1')).toEqual([
      expect.objectContaining({ id: 'a', status: 'shipped', priority: 'now', project_id: 'p1', sort_order: 1000 }),
    ]);
    for (const [id, original] of before) expect(next.find((item) => item.id === id)).toEqual(original);
  });

  it('is a no-op for an unknown card', () => {
    expect(dropTargetIndex(input, 'planned', 'missing', 'target-a')).toBe(-1);
    expect(applyReorder(input, 'missing', 'planned', 0)).toBe(input);
  });
});

describe('WORKING_COLUMNS', () => {
  it('is the four working statuses in lifecycle order', () => {
    expect(WORKING_COLUMNS).toEqual(['idea', 'planned', 'building', 'shipped']);
  });
});
