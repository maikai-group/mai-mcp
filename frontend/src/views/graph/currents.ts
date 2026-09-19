// The "currents" underlay (spec §5): a <canvas> beneath the cy container that
// paints each module as a soft radial glow at its members' centroid, with the
// module label at the hull edge and inter-module streams when zoomed out.
// Opacity rides the zoom envelope: full when far, 15% when near.
import type { Core } from 'cytoscape';
import type { GraphOverview } from '../../lib/types';
import { kindStyle } from '../../lib/kinds';
import { OBJECTIVES } from './model';
import type { UnderlaySpec } from './stylesheet';

// The zoom envelope the currents fade across: full at the widest objective,
// 15% at the tightest. Derived from the objective table so there is one source
// of truth for what "far" and "near" mean.
const ZOOM_FAR = OBJECTIVES[0].zoom;
const ZOOM_NEAR = OBJECTIVES[2].zoom;

function dominantColor(kinds: Record<string, number>): string {
  let best = '';
  let n = -1;
  for (const [k, c] of Object.entries(kinds)) if (c > n) { n = c; best = k; }
  return kindStyle(best).color;
}

/** #rrggbb → rgba() with the given alpha. */
function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(148,163,184,${alpha})`;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

export interface CurrentsController {
  setOverview(o: GraphOverview | null): void;
  setTheme(spec: UnderlaySpec): void;
  /** Ids to paint a pulse ring around; call after every merge/heart change. */
  setPulseIds(ids: Set<string>): void;
  redraw(): void;
  destroy(): void;
}

export function createCurrents(
  cy: Core,
  canvas: HTMLCanvasElement,
  spec: UnderlaySpec,
): CurrentsController {
  const ctx = canvas.getContext('2d');
  let overview: GraphOverview | null = null;
  let raf = 0;
  let underlay: UnderlaySpec = spec;
  let pulseIds = new Set<string>();
  let loop = 0;
  let phase = 0;

  const resize = () => {
    const c = cy.container();
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, c.clientWidth * dpr);
    canvas.height = Math.max(1, c.clientHeight * dpr);
    canvas.style.width = `${c.clientWidth}px`;
    canvas.style.height = `${c.clientHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = () => {
    if (!ctx) return;
    resize();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = underlay.base;
    ctx.fillRect(0, 0, w, h);
    if (underlay.gradient.length > 0) {
      const wash = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      underlay.gradient.forEach((stop, i) => {
        wash.addColorStop(underlay.gradient.length === 1 ? 0 : i / (underlay.gradient.length - 1), stop);
      });
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);
    }
    if (underlay.field === 'grid') {
      ctx.strokeStyle = underlay.fieldColor;
      ctx.lineWidth = 0.5;
      const step = 48;
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 0; y <= h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    } else if (underlay.field === 'starfield') {
      ctx.fillStyle = underlay.fieldColor;
      // Deterministic dust: a fixed LCG so the field does not shimmer on redraw.
      let seed = 1013904223;
      for (let i = 0; i < 220; i++) {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        const x = (seed / 4294967296) * w;
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        const y = (seed / 4294967296) * h;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    const zoom = cy.zoom();
    const currentsAlpha =
      zoom < ZOOM_FAR ? 1 : zoom > ZOOM_NEAR ? 0.15 : 1 - ((zoom - ZOOM_FAR) / (ZOOM_NEAR - ZOOM_FAR)) * 0.85;

    // Group rendered node positions by module.
    const groups = new Map<string, { xs: number[]; ys: number[] }>();
    cy.nodes().forEach((n) => {
      const m = n.data('module');
      if (!m) return;
      const p = n.renderedPosition();
      const g = groups.get(m) ?? { xs: [], ys: [] };
      g.xs.push(p.x);
      g.ys.push(p.y);
      groups.set(m, g);
    });

    const colorOf = new Map<string, string>();
    if (overview) for (const mod of overview.modules) colorOf.set(mod.label, dominantColor(mod.kinds));

    const centroid = new Map<string, { cx: number; cy: number; r: number }>();
    for (const [m, g] of groups) {
      const cx = g.xs.reduce((a, b) => a + b, 0) / g.xs.length;
      const cyy = g.ys.reduce((a, b) => a + b, 0) / g.ys.length;
      let r = 0;
      for (let i = 0; i < g.xs.length; i++) r = Math.max(r, Math.hypot(g.xs[i] - cx, g.ys[i] - cyy));
      r += 40;
      centroid.set(m, { cx, cy: cyy, r });
      const color = colorOf.get(m) ?? '#94a3b8';
      const grad = ctx.createRadialGradient(cx, cyy, 0, cx, cyy, r);
      grad.addColorStop(0, hexA(color, 0.12 * currentsAlpha * underlay.moduleGlow));
      grad.addColorStop(0.8, hexA(color, 0.04 * currentsAlpha * underlay.moduleGlow));
      grad.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cyy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Inter-module streams — only when zoomed out (below FAR).
    if (overview && zoom < ZOOM_FAR) {
      for (const link of overview.links) {
        const A = centroid.get(link.a);
        const B = centroid.get(link.b);
        if (!A || !B) continue;
        ctx.strokeStyle = hexA('#2dd4bf', 0.25 * currentsAlpha);
        ctx.lineWidth = Math.max(0.5, Math.log2(link.weight + 1));
        ctx.beginPath();
        ctx.moveTo(A.cx, A.cy);
        ctx.quadraticCurveTo((A.cx + B.cx) / 2, (A.cy + B.cy) / 2 - 30, B.cx, B.cy);
        ctx.stroke();
      }
    }

    // Module labels at the hull edge.
    if (overview) {
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = hexA('#64748b', Math.max(0.4, currentsAlpha));
      for (const mod of overview.modules) {
        const c = centroid.get(mod.label);
        if (!c) continue;
        ctx.fillText(`${mod.label} · ${mod.nodeCount}`, c.cx - c.r * 0.5, c.cy - c.r + 4);
      }
    }

    if (pulseIds.size > 0) {
      const amplitude = 0.5 + 0.5 * Math.sin(phase);
      ctx.lineWidth = 1.5;
      cy.nodes().forEach((n) => {
        if (!pulseIds.has(n.id())) return;
        const p = n.renderedPosition();
        const r = 14 + amplitude * 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = hexA(kindStyle(String(n.data('kind'))).color, 0.35 * (1 - amplitude));
        ctx.stroke();
      });
    }
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  };

  const tick = (): void => {
    phase += 0.06;
    draw();
    loop = window.requestAnimationFrame(tick);
  };
  const startLoop = (): void => {
    if (loop === 0 && !document.hidden && pulseIds.size > 0) loop = window.requestAnimationFrame(tick);
  };
  const stopLoop = (): void => {
    if (loop !== 0) { window.cancelAnimationFrame(loop); loop = 0; }
  };
  const onVisibility = (): void => { if (document.hidden) stopLoop(); else startLoop(); };
  document.addEventListener('visibilitychange', onVisibility);

  cy.on('render pan zoom resize', schedule);

  return {
    setOverview(o) { overview = o; schedule(); },
    setTheme(next) { underlay = next; schedule(); },
    setPulseIds(ids) {
      pulseIds = ids;
      if (ids.size === 0) stopLoop();
      else startLoop();
      schedule();
    },
    redraw() { schedule(); },
    destroy() {
      stopLoop();
      document.removeEventListener('visibilitychange', onVisibility);
      cy.removeListener('render pan zoom resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
