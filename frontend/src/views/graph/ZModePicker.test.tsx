import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ZModePicker } from './ZModePicker';

const all = { time: true, abstraction: true, confidence: true, free: true };
afterEach(cleanup);

describe('ZModePicker', () => {
  it('offers all four modes', () => {
    render(<ZModePicker active="time" availability={all} onPick={() => {}} />);
    for (const mode of ['time', 'abstraction', 'confidence', 'free']) {
      expect(screen.getByText(mode)).toBeTruthy();
    }
  });

  it('greys an unavailable mode and gives it a real reason, not "N/A"', () => {
    render(<ZModePicker active="time" availability={{ ...all, confidence: false }} onPick={() => {}} />);
    const chip = screen.getByText('confidence');
    expect(chip.hasAttribute('disabled')).toBe(true);
    expect(chip.getAttribute('data-zmode-available')).toBe('0');
    expect(chip.getAttribute('title')).toContain('lessons carry no node link');
  });

  it('does not fire onPick for a disabled mode', () => {
    const onPick = vi.fn();
    render(<ZModePicker active="time" availability={{ ...all, confidence: false }} onPick={onPick} />);
    fireEvent.click(screen.getByText('confidence'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('fires onPick for an available mode', () => {
    const onPick = vi.fn();
    render(<ZModePicker active="time" availability={all} onPick={onPick} />);
    fireEvent.click(screen.getByText('abstraction'));
    expect(onPick).toHaveBeenCalledWith('abstraction');
  });
});
