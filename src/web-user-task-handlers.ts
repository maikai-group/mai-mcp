import {
  listOperatorTasks,
  operatorTaskStatus,
  removeOperatorTasks,
  OperatorTaskConflictError,
  OperatorTaskNotFoundError,
  type OperatorTaskList,
  type OperatorTaskMutationResult,
  type OperatorTaskRemoveResult,
  type OperatorTaskRemoveTarget,
} from './operator-tasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UserTaskClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type UserTaskProjectResolver = (url: URL) => Promise<string>;
export type UserTaskGetHandler = (url: URL) => Promise<OperatorTaskList>;
export type UserTaskPostResult = OperatorTaskMutationResult | OperatorTaskRemoveResult;
export type UserTaskPostHandler = (
  body: Record<string, unknown>, url: URL,
) => Promise<UserTaskPostResult>;

function queryBoolean(url: URL, key: string): boolean {
  const value = url.searchParams.get(key);
  if (value === null || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new UserTaskClientError(`query '${key}' must be 0, 1, true, or false`);
}

function exactStatusBody(body: Record<string, unknown>): {
  taskId: string;
  action: 'complete' | 'reopen' | 'dismiss';
  reason?: string;
} {
  const allowed = ['task_id', 'action', 'reason'];
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new UserTaskClientError('request contains an unexpected field');
  }
  const taskId = body.task_id;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new UserTaskClientError("field 'task_id' must be a non-empty string");
  }
  const normalizedTaskId = taskId.trim();
  if (!UUID_RE.test(normalizedTaskId)) {
    throw new UserTaskClientError("field 'task_id' must be a UUID");
  }
  const action = body.action;
  if (action !== 'complete' && action !== 'reopen' && action !== 'dismiss') {
    throw new UserTaskClientError("field 'action' must be complete, reopen, or dismiss");
  }
  const reasonValue = body.reason;
  if (action !== 'dismiss' && reasonValue !== undefined) {
    throw new UserTaskClientError("field 'reason' is permitted only for dismiss");
  }
  if (action === 'dismiss') {
    if (typeof reasonValue !== 'string' || reasonValue.trim() === '') {
      throw new UserTaskClientError("field 'reason' must be a non-empty string for dismiss");
    }
    return { taskId: normalizedTaskId, action, reason: reasonValue.trim() };
  }
  return { taskId: normalizedTaskId, action };
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(body);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function exactRemoveBody(body: Record<string, unknown>): OperatorTaskRemoveTarget {
  if (body.mode === 'tasks') {
    if (!exactKeys(body, ['mode', 'task_ids'])) {
      throw new UserTaskClientError('request must contain one exact removal variant');
    }
    const taskIds = body.task_ids;
    if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 100) {
      throw new UserTaskClientError("field 'task_ids' must contain 1 to 100 UUIDs");
    }
    const normalized: string[] = [];
    for (const taskId of taskIds) {
      if (typeof taskId !== 'string' || !UUID_RE.test(taskId.trim())) {
        throw new UserTaskClientError("field 'task_ids' contains a non-UUID value");
      }
      normalized.push(taskId.trim().toLowerCase());
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new UserTaskClientError("field 'task_ids' must not contain duplicates");
    }
    return { mode: 'tasks', taskIds: normalized };
  }
  if (body.mode === 'group') {
    if (!exactKeys(body, ['mode', 'group_key', 'snapshot'])) {
      throw new UserTaskClientError('request must contain one exact removal variant');
    }
    const groupKey = body.group_key;
    if (typeof groupKey !== 'string'
        || (groupKey !== 'unlinked' && !/^plan:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupKey))) {
      throw new UserTaskClientError("field 'group_key' must be 'unlinked' or 'plan:<uuid>'");
    }
    const snapshot = body.snapshot;
    if (typeof snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot)) {
      throw new UserTaskClientError("field 'snapshot' must be 64 lowercase hex characters");
    }
    return { mode: 'group', groupKey, snapshot };
  }
  throw new UserTaskClientError('request must contain one exact removal variant');
}

export function createUserTaskGetHandlers(
  project: UserTaskProjectResolver,
): Record<string, UserTaskGetHandler> {
  return {
    '/api/user-tasks': async (url) => {
      const projectId = await project(url);
      return listOperatorTasks({
        projectId,
        includeHistory: queryBoolean(url, 'history'),
        summaryOnly: queryBoolean(url, 'summary'),
      });
    },
  };
}

export function createUserTaskPostHandlers(
  project: UserTaskProjectResolver,
): Record<string, UserTaskPostHandler> {
  return {
    '/api/user-tasks/status': async (body, url) => {
      const input = exactStatusBody(body);
      const projectId = await project(url);
      try {
        return await operatorTaskStatus({
          projectId,
          taskId: input.taskId,
          action: input.action,
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof OperatorTaskNotFoundError) {
          throw new UserTaskClientError('Operator task not found.', 404);
        }
        if (error instanceof OperatorTaskConflictError) {
          throw new UserTaskClientError('Operator task transition is not valid.', 409);
        }
        throw error;
      }
    },
    '/api/user-tasks/remove': async (body, url) => {
      const input = exactRemoveBody(body);
      const projectId = await project(url);
      try {
        return await removeOperatorTasks({ projectId, target: input });
      } catch (error) {
        if (error instanceof OperatorTaskNotFoundError) {
          throw new UserTaskClientError('Operator task not found.', 404);
        }
        if (error instanceof OperatorTaskConflictError) {
          throw new UserTaskClientError('Operator task removal is not valid.', 409);
        }
        throw error;
      }
    },
  };
}
