import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Drawer, type NodeDetail } from './Drawer';

afterEach(cleanup);

const detail: NodeDetail = {
  id: '123e4567-e89b-12d3-a456-426614174000', name: 'node a', kind: 'function',
  qualified_name: 'repo/src/a.ts#nodeA', file_path: 'src/a.ts', line: 10, degree: 7,
};

const renderDrawer = (isHeart: boolean, vesselCount: number) => render(
  <Drawer detail={detail} traceFromId={null} isHeart={isHeart}
    vesselCount={vesselCount} onExpand={() => {}} onClose={() => {}} />
);

describe('anatomy drawer', () => {
  it('identifies a selected heart and its direct vessel count', () => {
    renderDrawer(true, 7);
    const drawer = screen.getByText('the heart').closest('[data-node-heart]');
    expect(drawer?.getAttribute('data-node-heart')).toBe('1');
    expect(drawer?.getAttribute('data-node-vessels')).toBe('7');
    expect(screen.getByText('7 direct vessels')).toBeTruthy();
    expect(screen.getByText(detail.id)).toBeTruthy();
    expect(screen.getByText('src/a.ts:10')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'copy full node id' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'path' }).hasAttribute('disabled')).toBe(false);
  });

  it('identifies a non-heart selection without borrowing the heart count', () => {
    renderDrawer(false, 2);
    const drawer = screen.getByText('not the heart').closest('[data-node-heart]');
    expect(drawer?.getAttribute('data-node-heart')).toBe('0');
    expect(drawer?.getAttribute('data-node-vessels')).toBe('2');
    expect(screen.getByText('2 direct vessels')).toBeTruthy();
  });
});
