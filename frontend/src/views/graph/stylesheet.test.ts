import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { THEMES, themeById, resolveThemeId, DEFAULT_THEME_ID } from '../../lib/themes';
import { cytoscapeStyleFromTheme, underlaySpecFromTheme, edgeWidth } from './stylesheet';

describe('theme tokens', () => {
  it('ships exactly the four spec themes, Organism first and default', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['organism', 'observatory', 'atlas', 'signal']);
    expect(DEFAULT_THEME_ID).toBe('organism');
  });

  it('resolves unknown, corrupt, null and undefined to the default', () => {
    expect(resolveThemeId('riverbed')).toBe('organism');
    expect(resolveThemeId('')).toBe('organism');
    expect(resolveThemeId(null)).toBe('organism');
    expect(resolveThemeId(undefined)).toBe('organism');
    expect(resolveThemeId('atlas')).toBe('atlas');
    expect(themeById('nope').id).toBe('organism');
  });

  it('keeps kind colours out of the token — themes are atmosphere', () => {
    for (const t of THEMES) {
      expect(Object.keys(t)).not.toContain('kindColors');
    }
  });
});

describe('generated stylesheet', () => {
  for (const theme of THEMES) {
    it(`generates a stable stylesheet for ${theme.id}`, () => {
      const sheet = cytoscapeStyleFromTheme(theme);
      // Selector list is the structural contract; function-valued styles are
      // not snapshot-able, so assert selectors + the scalar style values.
      expect(sheet.map((r) => r.selector)).toMatchSnapshot();
      expect(underlaySpecFromTheme(theme)).toMatchSnapshot();
    });
  }

  it('edge width rises with strength and is capped', () => {
    const organism = themeById('organism');
    // 0 carries no information, so it takes the same baseline strength of 1 that
    // normalizeStrength gives a missing wire value: 1 + 1 * 0.55.
    expect(edgeWidth(organism, 0)).toBeCloseTo(1.55);
    expect(edgeWidth(organism, 4)).toBeCloseTo(3.2);
    expect(edgeWidth(organism, 1000)).toBe(organism.edge.maxWidth);
  });

  it('never emits NaN for a missing or junk strength', () => {
    const organism = themeById('organism');
    for (const junk of [undefined, null, NaN, 'x', {}]) {
      expect(Number.isFinite(edgeWidth(organism, junk))).toBe(true);
    }
  });
});

// ---- Structural: no per-theme branches outside themes.ts (R3) ----
// Symbol-aware rather than a literal/name grep: theme identity can flow through
// DEFAULT_THEME_ID, THEMES[0].id, an ordinary alias (including one populated by
// a later assignment), or renamed destructuring.
// Token reads such as theme.layout/theme.pulse remain allowed; only control flow
// keyed by identity is forbidden.
function themeBranchLines(file: string): number[] {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
  });
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`TypeScript did not load ${file}`);
  const checker = program.getTypeChecker();
  const resolving = new Set<ts.Symbol>();
  const assignedValues = new Map<ts.Symbol, ts.Expression[]>();

  // Index ordinary writes once before provenance is queried. This is
  // deliberately conservative and flow-insensitive: if an identifier used by
  // control flow can receive theme identity anywhere in the source file, it is
  // not a safe renderer branch key. Chained aliases work because each RHS is
  // sent back through readsThemeIdentity below.
  const indexAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let target: ts.Expression = node.left;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        const symbol = checker.getSymbolAtLocation(target);
        if (symbol !== undefined) {
          const values = assignedValues.get(symbol) ?? [];
          values.push(node.right);
          assignedValues.set(symbol, values);
        }
      }
    }
    node.forEachChild(indexAssignments);
  };
  indexAssignments(source);

  function isThemeIdValue(node: ts.Node): boolean {
    const type = checker.getTypeAtLocation(node);
    return type.aliasSymbol?.getName() === 'ThemeId'
      || type.symbol?.getName() === 'ThemeId';
  }

  function themeObject(node: ts.Expression): boolean {
    const expression = ts.isParenthesizedExpression(node) ? node.expression : node;
    const renderedType = checker.typeToString(checker.getTypeAtLocation(expression));
    if (/\bGraphTheme\b/.test(renderedType)) return true;
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (symbol === undefined || resolving.has(symbol)) return false;
      resolving.add(symbol);
      const found = (symbol.declarations ?? []).some((declaration) =>
        ts.isVariableDeclaration(declaration)
        && declaration.initializer !== undefined
        && themeObject(declaration.initializer));
      resolving.delete(symbol);
      return found;
    }
    if (ts.isCallExpression(expression) || ts.isElementAccessExpression(expression)) {
      return /\bGraphTheme\b/.test(renderedType);
    }
    return false;
  }

  function symbolCarriesIdentity(symbol: ts.Symbol): boolean {
    if (resolving.has(symbol)) return false;
    resolving.add(symbol);
    let found = (symbol.declarations ?? []).some((declaration) => {
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer === undefined || themeObject(declaration.initializer)) return false;
        return readsThemeIdentity(declaration.initializer);
      }
      if (!ts.isBindingElement(declaration)) return false;
      const property = declaration.propertyName ?? declaration.name;
      const selectsId = (ts.isIdentifier(property) || ts.isStringLiteral(property)) && property.text === 'id';
      if (!selectsId) return false;
      const holder = declaration.parent.parent;
      if (ts.isVariableDeclaration(holder)) {
        return holder.initializer !== undefined && themeObject(holder.initializer);
      }
      return ts.isParameter(holder)
        && holder.type !== undefined
        && /\bGraphTheme\b/.test(holder.type.getText(source));
    });
    if (!found) {
      found = (assignedValues.get(symbol) ?? []).some((value) =>
        !themeObject(value) && readsThemeIdentity(value));
    }
    resolving.delete(symbol);
    return found;
  }

  function readsThemeIdentity(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      if (node.text === 'DEFAULT_THEME_ID' || isThemeIdValue(node)) return true;
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && symbolCarriesIdentity(symbol)) return true;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // A token read (`theme.pulse`, `theme.layout`, …) is data-driven and
      // allowed. Only the token's identity property is branch identity.
      return node.name.text === 'id' && themeObject(node.expression);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      return key !== undefined
        && ts.isStringLiteral(key)
        && key.text === 'id'
        && themeObject(node.expression);
    }
    let found = false;
    node.forEachChild((child) => { if (!found && readsThemeIdentity(child)) found = true; });
    return found;
  }

  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    const condition = ts.isIfStatement(node) ? node.expression
      : ts.isSwitchStatement(node) ? node.expression
      : ts.isConditionalExpression(node) ? node.condition
      : null;
    if (condition !== null && readsThemeIdentity(condition)) {
      lines.push(source.getLineAndCharacterOfPosition(condition.getStart(source)).line + 1);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return lines;
}

describe('no per-theme branches', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  /**
   * RECURSIVE enumeration, never a hand-maintained allowlist. Revision 1 listed
   * six filenames and was therefore blind to `three/Landscape.tsx` — a
   * theme-consuming file a later task adds in a subdirectory. A list that must
   * be remembered is a list that will be forgotten; walking the tree means every
   * file a later task adds is guarded the moment it exists.
   */
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

  const guarded = (): string[] =>
    walk(here).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  // 30s budget, not the 5s default: this builds one TypeScript Program per
  // guarded file, and since Task 8 that includes three/Landscape.tsx, whose
  // three.js declarations dominate program creation. Measured at ~4s alone,
  // which flakes under full-suite parallel load. The assertion is unchanged —
  // only the wall-clock allowance is.
  it('finds no control flow keyed by theme identity at any depth', () => {
    const files = guarded();
    // Guards against the walk silently returning nothing (the vacuous-gate mode).
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const rel = path.relative(here, file);
      expect({ rel, lines: themeBranchLines(file) }).toEqual({ rel, lines: [] });
    }
 }, 30_000);

  it('reaches into subdirectories, which is where the 3D consumer lives', () => {
    const rels = guarded().map((f) => path.relative(here, f));
    // Once Task 8 lands, `three/Landscape.tsx` MUST be among the guarded files.
    // Before then the directory does not exist and the assertion is vacuous by
    // construction, so it is written as a conditional rather than a false claim.
    if (fs.existsSync(path.join(here, 'three'))) {
      expect(rels.some((r) => r.startsWith(`three${path.sep}`))).toBe(true);
    }
    expect(rels.every((r) => !r.includes('.test.'))).toBe(true);
  });
});
