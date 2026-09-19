import { add } from './util';

interface AppLike {
  get(route: string, handler: () => unknown): unknown;
}

const app: AppLike = { get: (_route, handler) => handler() };

app.get('/health', () => add(1, 2));

const db = { from: (table: string): string => table };
db.from('workouts');

export const reportQuery = `
  SELECT * FROM exercise_logs
  JOIN users ON users.id = exercise_logs.user_id
`;
