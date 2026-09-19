// The ten destinations (spec §4; Roadmap + Profile added by plan 11). Plain
// state routing — no router dependency; Shell keeps a useState<Destination>
// synced to location.hash.
export const DESTINATIONS = [
  'home',
  'review',
  'roadmap',
  'tasks',
  'sharing',
  'graph',
  'search',
  'timeline',
  'sessions',
  'topics',
  'profile',
] as const;

export type Destination = (typeof DESTINATIONS)[number];

export const DESTINATION_LABELS: Record<Destination, string> = {
  home: 'Home',
  review: 'Review',
  roadmap: 'Roadmap',
  tasks: 'My Tasks',
  sharing: 'Sharing',
  graph: 'Graph',
  search: 'Search',
  timeline: 'Timeline',
  sessions: 'Sessions',
  topics: 'Topics',
  profile: 'Profile',
};

export function isDestination(v: string): v is Destination {
  return (DESTINATIONS as readonly string[]).includes(v);
}
