// WebGL availability (spec §3.4). Injectable so it is testable without a GPU:
// jsdom's canvas returns null for every 3D context, which is exactly the
// "unavailable" case the 3D toggle must handle.
export type ContextGetter = (kind: string) => unknown;

export function hasWebGL(getContext?: ContextGetter): boolean {
  const get = getContext ?? ((kind: string) => {
    if (typeof document === 'undefined') return null;
    try {
      return document.createElement('canvas').getContext(kind);
    } catch {
      return null;
    }
  });
  for (const kind of ['webgl2', 'webgl', 'experimental-webgl']) {
    // The guard belongs here, not only in the default getter: an INJECTED
    // getter that throws is the hardened/blocked-context case, and this probe
    // must be total — an exception during render would take the Graph down.
    try {
      if (get(kind) != null) return true;
    } catch {
      // treat as unavailable and keep probing the remaining kinds
    }
  }
  return false;
}

export const WEBGL_UNAVAILABLE_MESSAGE =
  'This browser has no WebGL context, so the 3D landscape cannot render. The 2D view is unaffected.';
