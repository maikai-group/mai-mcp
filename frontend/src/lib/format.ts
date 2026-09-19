// Small display helpers shared across views.

/** Human relative time: "just now", "12m", "3h", "2d", else a date. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** First 8 chars of an id/hash (matches the brain's short-id convention). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
