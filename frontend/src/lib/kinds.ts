// Kind → visual style (spec §3). Open vocabulary, so every lookup falls back.
export type NodeShape = 'ellipse' | 'round-rectangle' | 'rectangle';
export interface KindStyle { color: string; shape: NodeShape; label: string }
const K = (color: string, shape: NodeShape, label: string): KindStyle => ({ color, shape, label });
export const KIND_STYLES: Record<string, KindStyle> = {
  function: K('#2dd4bf', 'ellipse', 'function'),
  method: K('#2dd4bf', 'ellipse', 'method'),
  class: K('#a78bfa', 'ellipse', 'class'),
  module: K('#a78bfa', 'round-rectangle', 'module'),
  file: K('#60a5fa', 'round-rectangle', 'file'),
  script: K('#60a5fa', 'round-rectangle', 'script'),
  table: K('#f59e0b', 'rectangle', 'table'),
  column: K('#f59e0b', 'rectangle', 'column'),
  policy: K('#f59e0b', 'rectangle', 'policy'),
  endpoint: K('#f472b6', 'ellipse', 'endpoint'),
  command: K('#f472b6', 'round-rectangle', 'command'),
  package_script: K('#f472b6', 'round-rectangle', 'npm script'),
  scheduled_job: K('#f472b6', 'round-rectangle', 'job'),
  mcp_server: K('#f472b6', 'round-rectangle', 'mcp'),
  env_var: K('#94a3b8', 'rectangle', 'env'),
};
export const FALLBACK_KIND: KindStyle = K('#94a3b8', 'ellipse', 'node');
export const kindStyle = (kind: string): KindStyle => KIND_STYLES[kind] ?? FALLBACK_KIND;
