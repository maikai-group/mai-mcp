import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Legend } from './Legend';

const counts = new Map([['function', 12], ['file', 3]]);
afterEach(cleanup);

describe('Legend', () => {
  it('renders a kind · n chip per present kind', () => {
    render(<Legend counts={counts} hidden={[]} onToggle={() => {}} onShowAll={() => {}} />);
    expect(screen.getByText('function · 12')).toBeTruthy();
    expect(screen.getByText('file · 3')).toBeTruthy();
  });

  it('renders nothing when no kinds are loaded', () => {
    const { container } = render(<Legend counts={new Map()} hidden={[]} onToggle={() => {}} onShowAll={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('marks hidden kinds unpressed and enables show-all only when something is hidden', () => {
    const onShowAll = vi.fn();
    const { rerender } = render(<Legend counts={counts} hidden={[]} onToggle={() => {}} onShowAll={onShowAll} />);
    const showAll = screen.getByText('show all');
    expect(showAll.hasAttribute('disabled')).toBe(true);
    rerender(<Legend counts={counts} hidden={['file']} onToggle={() => {}} onShowAll={onShowAll} />);
    expect(screen.getByText('show all').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByText('show all'));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('toggles the clicked kind', () => {
    const onToggle = vi.fn();
    render(<Legend counts={counts} hidden={[]} onToggle={onToggle} onShowAll={() => {}} />);
    fireEvent.click(screen.getByText('file · 3'));
    expect(onToggle).toHaveBeenCalledWith('file');
  });
});
