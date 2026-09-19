import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { IdeaRow } from '../../lib/types';

const mocks = vi.hoisted(() => {
  const push = vi.fn();
  return { apiPost: vi.fn(), push, toast: { push } };
});
vi.mock('../../lib/api', () => ({ apiPost: mocks.apiPost }));
vi.mock('../../shell/toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../shell/settings', () => ({
  useSettings: () => ({
    settings: { 'roadmap.global_marker': '🧭' },
    setSetting: vi.fn().mockResolvedValue(true),
  }),
}));

import { IdeaFormModal } from './IdeaFormModal';

const card: IdeaRow = {
  id: '11111111-2222-3333-4444-555555555555',
  project_id: null,
  title: 'global card',
  detail: 'existing detail',
  status: 'idea',
  priority: 'later',
  sort_order: 1000,
  source: 'agent-inferred',
  evidence: null,
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T00:00:00.000Z',
};

describe('IdeaFormModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPost.mockResolvedValue({});
  });
  afterEach(cleanup);

  it('add mode parks via POST /ideas', async () => {
    render(<IdeaFormModal mode="add" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("One line — what's the idea?"), {
      target: { value: 'a fresh idea' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Park idea' }));
    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas', {
      title: 'a fresh idea', detail: undefined, priority: 'someday', scope: 'project',
    }));
  });

  it('renders the configured marker in the global scope label', () => {
    render(<IdeaFormModal mode="add" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'global 🧭' })).toBeTruthy();
  });

  it('edit mode pre-fills and disables Save until something changes', () => {
    const whitespaceCard = { ...card, detail: '  existing detail  ' };
    render(<IdeaFormModal mode="edit" card={whitespaceCard} onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByPlaceholderText("One line — what's the idea?");
    if (!(input instanceof HTMLInputElement)) throw new Error('title control is not an input');
    expect(input.value).toBe('global card');
    const detailInput = screen.getByPlaceholderText('Detail (optional) — ⌘/Ctrl+Enter to save');
    if (!(detailInput instanceof HTMLTextAreaElement)) throw new Error('detail control is not a textarea');
    expect(detailInput.value).toBe('  existing detail  ');
    const save = screen.getByRole('button', { name: 'Save changes' });
    if (!(save instanceof HTMLButtonElement)) throw new Error('save control is not a button');
    expect(save.disabled).toBe(true);
  });

  it('edit mode sends changed title, priority, and scope while omitting unchanged fields', async () => {
    const onSaved = vi.fn();
    render(<IdeaFormModal mode="edit" card={card} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText("One line — what's the idea?"), {
      target: { value: 'renamed card' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'now' }));
    fireEvent.click(screen.getByRole('button', { name: 'this project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/update', {
      idea_id: card.id, title: 'renamed card', priority: 'now', scope: 'project',
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('submits a priority-only edit and delegates successful reseating to the owner reload', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<IdeaFormModal mode="edit" card={card} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/update', {
      idea_id: card.id, priority: 'now',
    }));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clearing detail sends an empty string (server stores NULL)', async () => {
    render(<IdeaFormModal mode="edit" card={card} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Detail (optional) — ⌘/Ctrl+Enter to save'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/ideas/update', {
      idea_id: card.id, detail: '',
    }));
  });
});
