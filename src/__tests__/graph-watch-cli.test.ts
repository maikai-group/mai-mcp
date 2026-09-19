import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', async importOriginal => {
  const original = await importOriginal<typeof import('../db.js')>();
  return { ...original, resolveProjectId: vi.fn(async () => '11111111-1111-4111-8111-111111111111') };
});
vi.mock('../graph/watch-cli.js', () => ({ runGraphWatch: vi.fn(async () => 'Graph watcher stopped.') }));
vi.mock('../graph/db-url.js', () => ({ resolveConsumerGraphDbUrl: vi.fn(async () => 'postgresql://fixture/fallback') }));
vi.mock('../exit.js', () => ({ finishAndExit: vi.fn(async () => {}) }));

import { main, runCli } from '../cli.js';
import { runGraphWatch } from '../graph/watch-cli.js';
import { resolveConsumerGraphDbUrl } from '../graph/db-url.js';
import { finishAndExit } from '../exit.js';
const saved = { slug: process.env.MAI_PROJECT_SLUG, graph: process.env.MAI_GRAPH_DB_URL, code: process.exitCode };
beforeEach(() => {
  vi.clearAllMocks(); process.exitCode = undefined;
  process.env.MAI_PROJECT_SLUG = 'pinned'; process.env.MAI_GRAPH_DB_URL = '';
  vi.mocked(runGraphWatch).mockResolvedValue('Graph watcher stopped.');
  vi.spyOn(process.stdout, 'write').mockReturnValue(true); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  if (saved.slug === undefined) delete process.env.MAI_PROJECT_SLUG; else process.env.MAI_PROJECT_SLUG = saved.slug;
  if (saved.graph === undefined) delete process.env.MAI_GRAPH_DB_URL; else process.env.MAI_GRAPH_DB_URL = saved.graph;
  process.exitCode = saved.code; vi.restoreAllMocks();
});
describe('graph watch CLI routing', () => {
  it.each(['--db-url', '--postgres'])('routes an explicit project and %s', async flag => {
    await main(['graph', 'watch', '--project', 'other', flag, 'postgresql://fixture/explicit']);
    expect(runGraphWatch).toHaveBeenCalledWith({ projectId: '11111111-1111-4111-8111-111111111111', slug: 'other', dbUrl: 'postgresql://fixture/explicit' });
    expect(resolveConsumerGraphDbUrl).not.toHaveBeenCalled();
  });
  it('uses the pinned environment URL and falls back to the project configuration', async () => {
    process.env.MAI_GRAPH_DB_URL = 'postgresql://fixture/pinned'; await main(['graph', 'watch']);
    expect(runGraphWatch).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'pinned', dbUrl: 'postgresql://fixture/pinned' }));
    process.env.MAI_GRAPH_DB_URL = ''; await main(['graph', 'watch']);
    expect(runGraphWatch).toHaveBeenLastCalledWith(expect.objectContaining({ dbUrl: 'postgresql://fixture/fallback' }));
  });
  it('does not reuse the pinned project database for another project', async () => {
    process.env.MAI_GRAPH_DB_URL = 'postgresql://fixture/private'; await main(['graph', 'watch', '--project', 'other']);
    expect(runGraphWatch).toHaveBeenCalledWith(expect.objectContaining({ slug: 'other', dbUrl: undefined }));
    expect(resolveConsumerGraphDbUrl).not.toHaveBeenCalled();
  });
  it('drains exactly once after normal watcher completion', async () => {
    await runCli(['graph', 'watch']); expect(finishAndExit).toHaveBeenCalledTimes(1); expect(finishAndExit).toHaveBeenCalledWith(0);
  });
  it('drains exactly once with a nonzero status after watcher failure', async () => {
    vi.mocked(runGraphWatch).mockRejectedValueOnce(new Error('Graph watch stopped: no source subscriptions remain.'));
    await runCli(['graph', 'watch']); expect(finishAndExit).toHaveBeenCalledTimes(1); expect(finishAndExit).toHaveBeenCalledWith(1);
  });
  it('advertises the foreground command in help', async () => {
    await main(['--help']); expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('graph watch'));
  });
});
