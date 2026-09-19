// Theme token → cytoscape stylesheet + underlay paint spec (spec §3.2). This is
// the ONLY place a GraphTheme becomes visual instructions. It contains no theme
// id literal and no per-theme branch: every difference between themes is a
// difference in the token values it reads. stylesheet.test.ts asserts that
// structurally, so the rule cannot rot.
import type cytoscape from 'cytoscape';
import type { NodeSingular, EdgeSingular } from 'cytoscape';
import { kindStyle } from '../../lib/kinds';
import { relationStyle } from '../../lib/relations';
import type { GraphTheme } from '../../lib/themes';

/** Vessel width from edge strength (spec §3.3). Total: a missing or non-finite
 * strength falls back to the baseline width, never NaN into the renderer. */
export function edgeWidth(theme: GraphTheme, strength: unknown): number {
  const s = typeof strength === 'number' && Number.isFinite(strength) && strength > 0 ? strength : 1;
  const w = theme.edge.baseWidth + Math.max(0, s) * theme.edge.strengthScale;
  return Math.min(theme.edge.maxWidth, w);
}

function nodeSize(ele: NodeSingular): number {
  const degree = Number(ele.data('degree') ?? 0);
  return 12 + Math.min(18, Math.sqrt(Number.isFinite(degree) ? degree : 0) * 3);
}

/** What the underlay canvas needs; currents.ts consumes exactly this. */
export interface UnderlaySpec {
  base: string;
  gradient: readonly string[];
  field: GraphTheme['background']['field'];
  fieldColor: string;
  moduleGlow: number;
}

export function underlaySpecFromTheme(theme: GraphTheme): UnderlaySpec {
  return {
    base: theme.background.base,
    gradient: theme.background.gradient,
    field: theme.background.field,
    fieldColor: theme.background.fieldColor,
    moduleGlow: theme.background.moduleGlow,
  };
}

export function cytoscapeStyleFromTheme(theme: GraphTheme): cytoscape.StylesheetJson {
  const { node, edge } = theme;
  return [
    {
      selector: 'node',
      style: {
        'background-color': (e: NodeSingular) => kindStyle(String(e.data('kind'))).color,
        'background-opacity': node.fillOpacity,
        shape: (e: NodeSingular) => kindStyle(String(e.data('kind'))).shape,
        width: (e: NodeSingular) => nodeSize(e),
        height: (e: NodeSingular) => nodeSize(e),
        'border-width': node.borderWidth,
        'border-color': (e: NodeSingular) => kindStyle(String(e.data('kind'))).color,
        'border-opacity': node.body === 'hollow' ? 1 : 0.55,
        label: 'data(label)',
        color: node.labelColor,
        'font-size': node.labelSize,
        'font-family': node.labelFont,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-opacity': 0,
        'text-outline-color': node.labelOutline,
        'text-outline-width': 2,
      },
    },
    // Halo as an overlay ring — the honest ~90% of bloom (spec §3.2). Zero
    // padding collapses it, which is how Signal opts out with no branch.
    {
      selector: 'node',
      style: {
        'overlay-color': (e: NodeSingular | EdgeSingular) => kindStyle(String(e.data('kind'))).color,
        'overlay-opacity': node.haloOpacity,
        'overlay-padding': node.haloPadding,
      },
    },
    { selector: 'node.labels-on', style: { 'text-opacity': 1 } },
    { selector: 'node.hidden-kind', style: { display: 'none' } },
    // The 7-day pulse ring. currents.ts animates 'pulse-strength' on the class;
    // a theme with pulse:false never gets the class added (canvas.ts reads
    // theme.pulse — a token read, not a theme branch).
    {
      selector: 'node.recent',
      style: { 'overlay-opacity': Math.min(1, node.haloOpacity + 0.18), 'overlay-padding': node.haloPadding + 4 },
    },
    {
      selector: 'node.heart',
      style: {
        'background-color': theme.heartColor,
        'border-color': theme.heartColor,
        'border-width': node.borderWidth + 2,
        'background-opacity': 1,
        'overlay-color': theme.heartColor,
        'overlay-opacity': 0.28,
        'overlay-padding': node.haloPadding + 8,
        'text-opacity': 1,
      },
    },
    {
      selector: 'node[center = 1]',
      style: { 'text-opacity': 1, 'border-width': node.borderWidth + 1.6, 'border-opacity': 1 },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': node.borderWidth + 1.6,
        'border-color': theme.chrome.accent,
        'overlay-color': theme.chrome.accent,
        'overlay-opacity': Math.max(0.15, node.haloOpacity),
        'overlay-padding': node.haloPadding + 2,
        'text-opacity': 1,
      },
    },
    {
      selector: 'edge',
      style: {
        width: (e: EdgeSingular) => edgeWidth(theme, e.data('strength')),
        'line-color': (e: EdgeSingular) => relationStyle(String(e.data('relation'))).color,
        'line-style': (e: EdgeSingular) => relationStyle(String(e.data('relation'))).lineStyle,
        'curve-style': edge.curve,
        opacity: edge.opacity,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': (e: EdgeSingular) => relationStyle(String(e.data('relation'))).color,
        'arrow-scale': edge.arrowScale,
      },
    },
  ];
}
