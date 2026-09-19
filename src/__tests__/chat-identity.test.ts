import { describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  agentIdentity, bindChatIdentity, chatAuthorLabel, claudeChatBootstrap,
  coordinationIdentity, createChatBinding, currentChatIdentity, INSTANCE_SESSION,
  parseChatIdentity,
} from '../session-identity.js';

// Exercise actual MCP dispatch and board insertion without touching any brain.
const db = vi.hoisted(() => ({ query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: 'message-1' }] })) }));
vi.mock('../db.js', () => ({
  getProjectId: async () => 'identity-test-project',
  getPool: () => ({ connect: async () => ({ query: db.query, release: () => {} }) }),
  dbErrorHint: () => '',
}));
vi.mock('../write-gate.js', () => ({ enforceCharLimits: async () => {} }));
vi.mock('../prime.js', async importOriginal => {
  const original = await importOriginal<typeof import('../prime.js')>();
  return { ...original, prime: async () => original.renderPrimeIdentityLine() };
});

const native = { provider: 'codex', id: '01a08e74-1980-71d3-b0f6-57cf6eb36c84', client: 'codex-cli' };

describe('native chat identity', () => {
  it('keeps fallback and ownership aliases unchanged before binding', () => {
    expect(currentChatIdentity()).toBeUndefined();
    expect(coordinationIdentity({ MAI_AGENT_ID: 'codex-cli' })).toBe('codex-cli');
    expect(agentIdentity({})).toBe('unknown-agent');
  });

  it('resumes with the same name across independent connections; forks get another', () => {
    const a = createChatBinding().bind(native);
    const resumed = createChatBinding().bind(native);
    const fork = createChatBinding().bind({ ...native, id: 'different-thread' });
    expect(resumed).toEqual(a);
    expect(a.name).toMatch(/^[A-Za-z]+-[a-f0-9]{8}$/);
    expect(fork.name).not.toBe(a.name);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('names follow the chat, not model, client surface, profile or process', () => {
    const cli = parseChatIdentity(native);
    const desktop = parseChatIdentity({ ...native, client: 'codex-desktop' });
    expect(cli.name).toBe(desktop.name);
    expect(chatAuthorLabel(cli)).not.toBe(chatAuthorLabel(desktop));
    expect(parseChatIdentity({ provider: 'claude', id: native.id }).name).not.toBe(cli.name);
  });

  it('retains harness-assigned names while the full provider ID disambiguates authors', () => {
    const named = parseChatIdentity({ ...native, name: 'Sol' });
    expect(named.name).toBe('Sol');
    expect(chatAuthorLabel(named)).toBe(`Sol · codex-cli · codex:${native.id}`);
    expect(chatAuthorLabel(parseChatIdentity({ ...native, name: 'Sol', id: 'other' }))).not.toBe(chatAuthorLabel(named));
  });

  it('repeated binding is idempotent and refuses silent connection relabelling', () => {
    const binding = createChatBinding();
    const chat = binding.bind(native);
    expect(binding.bind(native)).toBe(chat);
    expect(() => binding.bind({ ...native, id: 'other-chat' })).toThrow(/reconnect/);
    expect(binding.get()).toBe(chat);
  });

  it.each([
    null, [], {}, { ...native, id: '' }, { ...native, id: 'x'.repeat(129) },
    { ...native, id: 'x\nforged' }, { ...native, id: '../transcript' },
    { ...native, provider: 'invented' }, { ...native, client: 'claude-code' },
    { ...native, client: 'not-a-client' }, { ...native, name: 'forged\nname' },
    { ...native, name: 'x'.repeat(25) }, { ...native, extra: true },
  ])('rejects malformed identity without mutating a binding: %j', value => {
    const binding = createChatBinding();
    expect(() => binding.bind(value)).toThrow();
    expect(binding.get()).toBeUndefined();
  });

  it('uses an honest unknown client when the host exposes no surface label', () => {
    expect(parseChatIdentity({ provider: 'claude', id: 'session-1' }).client).toBe('unknown-client');
  });

  it('bootstraps Claude from the hook ID, never a parent environment ID or transcript', () => {
    const output = claudeChatBootstrap({ session_id: 'child-session' }, {
      MAI_CLIENT_ID: 'claude-code', MAI_CHAT_NAME: 'Fable', CODEX_THREAD_ID: 'parent-thread',
    });
    expect(output).toContain('"id":"child-session"');
    expect(output).toContain('"name":"Fable"');
    expect(output).toContain('"client":"claude-code"');
    expect(output).not.toContain('parent-thread');
    expect(claudeChatBootstrap({ session_id: '../bad' }, {})).toBe('');
    expect(claudeChatBootstrap({}, {})).toBe('');
  });

  it('carries identity through MCP prime, board author and metadata without changing process ownership', async () => {
    process.env.MAI_PROJECT_SLUG = 'identity-test-project';
    const { buildServer } = await import('../index.js');
    const { postMessage, SERVER_AGENT } = await import('../coordination/board.js');
    const server = buildServer(async () => '');
    const client = new Client({ name: 'chat-identity-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const ownerBefore = INSTANCE_SESSION;
    try {
      const result = await client.callTool({ name: 'mai_prime', arguments: { task_description: 'test identity', chat: native } });
      expect(result.isError).not.toBe(true);
      expect(result._meta?.chat_identity).toEqual(parseChatIdentity(native));
      expect(JSON.stringify(result.content)).toContain('codex-cli');
      expect(currentChatIdentity()).toEqual(parseChatIdentity(native));
      expect(bindChatIdentity(native)).toBe(currentChatIdentity());

      db.query.mockClear();
      const post = await client.callTool({ name: 'mai_board_post', arguments: { type: 'note', body: 'hello' } });
      expect(post.isError).not.toBe(true);
      const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_messages'));
      expect(insert?.[1]?.[2]).toBe(chatAuthorLabel(parseChatIdentity(native)));
      expect(insert?.[1]?.[3]).toBe(ownerBefore);
      expect(agentIdentity({ MAI_AGENT_ID: 'codex-cli' })).toBe('codex-cli');
      expect(INSTANCE_SESSION).toBe(ownerBefore);

      db.query.mockClear();
      await postMessage({ type: 'note', body: 'server note', author: SERVER_AGENT });
      expect(db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_messages'))?.[1]?.[2]).toBe(SERVER_AGENT);

      const invalid = await client.callTool({ name: 'mai_prime', arguments: { task_description: 'test identity', chat: { ...native, id: 'other' } } });
      expect(invalid.isError).toBe(true);
      expect(currentChatIdentity()?.id).toBe(native.id);
      const repeated = await client.callTool({ name: 'mai_prime', arguments: { task_description: 'continue' } });
      expect(repeated._meta?.chat_identity).toEqual(parseChatIdentity(native));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
