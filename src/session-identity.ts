// Process ownership is deliberately NOT chat identity. A resumed conversation
// gets the same display name, but never inherits a dead process's claims.
import { createHash, randomUUID } from 'node:crypto';

export const INSTANCE_SESSION = randomUUID();

export function agentIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAI_AGENT_ID ?? 'unknown-agent';
}

export const CHAT_CLIENTS = ['codex-cli', 'codex-desktop', 'claude-code', 'claude-desktop', 'unknown-client'] as const;
export type ChatClient = typeof CHAT_CLIENTS[number];
export interface ChatIdentity {
  readonly provider: 'codex' | 'claude';
  /** Native thread ID, not a process ID or the root of a fork tree. */
  readonly id: string;
  readonly client: ChatClient;
  readonly name: string;
}

// Versioned, fixed vocabulary: changing it would rename resumed chats.
const CHAT_NAMES_V1 = ['Cedar', 'Birch', 'Maple', 'Willow', 'Aspen', 'Rowan', 'Alder', 'Hazel',
  'Juniper', 'Laurel', 'Linden', 'Olive', 'Pine', 'Spruce', 'Elm', 'Oak'] as const;

export function parseChatIdentity(input: unknown): ChatIdentity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('chat must be an object');
  const allowed = new Set(['provider', 'id', 'client', 'name']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('unknown chat identity field');
  if (!('provider' in input) || (input.provider !== 'codex' && input.provider !== 'claude')) {
    throw new Error('chat.provider must be codex or claude');
  }
  if (!('id' in input) || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.id)) {
    throw new Error('chat.id must be the native chat ID (1–128 safe identifier characters)');
  }
  const client = 'client' in input ? input.client : 'unknown-client';
  const knownClient = CHAT_CLIENTS.find(value => value === client);
  if (!knownClient) throw new Error('invalid chat.client');
  if (knownClient !== 'unknown-client' && !knownClient.startsWith(input.provider)) {
    throw new Error('chat.client does not match chat.provider');
  }
  const digest = createHash('sha256').update(JSON.stringify([input.provider, input.id])).digest('hex');
  let name: string = `${CHAT_NAMES_V1[parseInt(digest.slice(0, 2), 16) % CHAT_NAMES_V1.length]}-${digest.slice(0, 8)}`;
  if ('name' in input) {
    if (typeof input.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(input.name)) {
      throw new Error('chat.name must be 1–24 letters, digits, hyphens or underscores, starting with a letter');
    }
    name = input.name;
  }
  return Object.freeze({ provider: input.provider, id: input.id, client: knownClient, name });
}

/** One explicit binding per MCP connection; never guess from cwd/latest logs.
 * Repeating prime is free of identity writes. Reconnect before changing chats
 * on a reused connection, so one chat cannot silently relabel another's work. */
export function createChatBinding() {
  let chat: ChatIdentity | undefined;
  return {
    get: () => chat,
    bind(input: unknown): ChatIdentity {
      const next = parseChatIdentity(input);
      if (chat && JSON.stringify(chat) !== JSON.stringify(next)) {
        throw new Error('This MCP connection is already bound to another chat identity; reconnect it for the new chat.');
      }
      chat ??= next;
      return chat;
    },
  };
}

const binding = createChatBinding();
export const bindChatIdentity = binding.bind;
export const currentChatIdentity = binding.get;

/** Full provider ID is durable in author_agent, not merely a truncated hash.
 * This is attribution, NOT authentication and NOT a live PTY route. */
export function chatAuthorLabel(chat: ChatIdentity): string {
  return `${chat.name} · ${chat.client} · ${chat.provider}:${chat.id}`;
}

export function coordinationIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const chat = currentChatIdentity();
  return chat ? chatAuthorLabel(chat) : agentIdentity(env);
}

/** Hook input is a native session source. A hook subprocess cannot set the
 * already-running MCP server's environment; pass this through existing prime. */
export function claudeChatBootstrap(payload: unknown, env: NodeJS.ProcessEnv): string {
  if (!payload || typeof payload !== 'object' || !('session_id' in payload)) return '';
  try {
    const chat = parseChatIdentity({
      provider: 'claude', id: payload.session_id,
      client: env.MAI_CLIENT_ID ?? 'unknown-client',
      ...(env.MAI_CHAT_NAME ? { name: env.MAI_CHAT_NAME } : {}),
    });
    return `Chat identity: include chat=${JSON.stringify(chat)} in your first mai_prime call on this MCP connection. Use this native ID, not a copied ID from prior context.\n`;
  } catch {
    return ''; // malformed hook metadata must not break session startup
  }
}
