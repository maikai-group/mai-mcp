// mai-graph shell extractor (spec §3.3) — tree-sitter-bash via WASM. Script
// nodes for .sh/.bash files; `invokes` edges to command nodes (shared kind)
// and to project files a script runs; `reads_env` edges to env_var nodes per
// $VAR/${VAR}; shebang → lang. Local-only, no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { Query, type Node } from 'web-tree-sitter';
import { owningRegisteredRepo, serviceIdentity, sourceQNameForPath } from '../contracts.js';
import { hashContent } from '../engine.js';
import { loadLanguage, parserFor } from '../parsers.js';
import { canonicalPhysicalPath, canonicalRegisteredRoots } from '../roots.js';
import { listOwnedRepoFiles } from '../walk.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';

export const SHELL_EXT = new Set(['.sh', '.bash']);
const BUILTIN_CMDS = new Set([
  'cd', 'echo', 'exit', 'set', 'export', 'source', '.', 'true', 'false', 'shift',
  'return', 'local', 'read', 'trap', 'umask', 'unset', 'wait', 'eval', 'exec',
  'printf', 'test', '[', '[[', 'sleep', 'shopt', 'declare', 'typeset',
]);
const SPECIAL_VARS = /^([0-9]+|[@*#?$!_-])$/;

const QUERY_SRC =
  '(command) @command (expansion (variable_name) @var) (simple_expansion (variable_name) @var)';

function shebangLang(text: string): string {
  const first = text.split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return 'bash';
  if (first.includes('zsh')) return 'zsh';
  if (first.includes('bash')) return 'bash';
  if (/\bsh\b/.test(first)) return 'sh';
  return 'bash';
}

/** A command argument that points at a real file inside one of the repos →
 * a NodeRef to it (script for .sh/.bash, file otherwise). */
function resolveFileArg(
  arg: string,
  scriptDir: string,
  qnameOf: (absPath: string) => string | null
): NodeRef | null {
  if (!/^[\w@./~-]+$/.test(arg) || arg === '.' || arg === '..') return null;
  const abs = path.isAbsolute(arg) ? path.resolve(arg) : path.resolve(scriptDir, arg);
  let isFile = false;
  try {
    isFile = fs.statSync(abs).isFile();
  } catch {
    return null;
  }
  if (!isFile) return null;
  const qn = qnameOf(abs);
  if (!qn) return null;
  const ext = path.extname(abs);
  return { kind: SHELL_EXT.has(ext) ? 'script' : 'file', qualifiedName: qn };
}

export const shellExtractor: GraphExtractor = {
  name: 'shell',
  vocabulary: {
    kinds: ['script', 'command', 'env_var'],
    relations: ['invokes', 'reads_env'],
  },
  async extract({ repoPaths, changedFiles, excludes }): Promise<ExtractorOutput> {
    const nodes: ExtractedNode[] = [];
    const edges: ExtractedEdge[] = [];
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const identities = new Map(resolvedRepos.map((repo) => [repo, serviceIdentity(repo)]));
    const qnameOf = (absPath: string): string | null => {
      const physical = canonicalPhysicalPath(absPath, process.cwd());
      const owner = owningRegisteredRepo(physical, resolvedRepos);
      if (owner === null) return null;
      const identity = identities.get(owner);
      if (identity === undefined) return null;
      const legacy = `${path.basename(owner)}/${path.relative(owner, physical).split(path.sep).join('/')}`;
      return sourceQNameForPath(identity.id, legacy, path.extname(physical));
    };

    const changed = changedFiles ? new Set(changedFiles.map((p) => path.resolve(p))) : null;
    const files: string[] = [];
    for (const repo of resolvedRepos) files.push(...listOwnedRepoFiles(repo, resolvedRepos, SHELL_EXT, excludes ?? []));
    const targets = changed ? files.filter((f) => changed.has(path.resolve(f))) : files;
    if (targets.length === 0) return { nodes, edges };

    const parser = await parserFor('bash');
    const lang = await loadLanguage('bash');
    const query = new Query(lang, QUERY_SRC);

    for (const abs of targets) {
      const qn = qnameOf(abs);
      if (!qn) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const scriptRef: NodeRef = { kind: 'script', qualifiedName: qn };
      nodes.push({
        kind: 'script',
        name: path.basename(abs),
        qualifiedName: qn,
        filePath: abs,
        lang: shebangLang(text),
        contentHash: hashContent(text),
      });

      const tree = parser.parse(text);
      if (!tree) continue;
      for (const cap of query.captures(tree.rootNode)) {
        if (cap.name === 'var') {
          const v = cap.node.text;
          if (SPECIAL_VARS.test(v)) continue;
          const envQn = `env:${v}`;
          nodes.push({ kind: 'env_var', name: v, qualifiedName: envQn });
          edges.push({ from: scriptRef, to: { kind: 'env_var', qualifiedName: envQn }, relation: 'reads_env' });
          continue;
        }
        // cap.name === 'command'
        const cmdNode: Node = cap.node;
        const nameNode = cmdNode.childForFieldName('name');
        const cmdName = nameNode?.text ?? '';
        if (!cmdName || cmdName.includes('$')) continue;
        const baseCmd = path.basename(cmdName);
        const line = cmdNode.startPosition.row + 1;
        if (!BUILTIN_CMDS.has(baseCmd)) {
          // The command itself may be a project file (e.g. ./deploy.sh).
          const selfRef = resolveFileArg(cmdName, path.dirname(abs), qnameOf);
          if (selfRef) {
            edges.push({ from: scriptRef, to: selfRef, relation: 'invokes', metadata: { line } });
          } else {
            const cmdQn = `cmd:${baseCmd}`;
            nodes.push({ kind: 'command', name: baseCmd, qualifiedName: cmdQn });
            edges.push({ from: scriptRef, to: { kind: 'command', qualifiedName: cmdQn }, relation: 'invokes', metadata: { line } });
          }
        }
        // Arguments that are project files (node x.js, python3 y.py, bash z.sh).
        // Direct named children of `command` are the command_name plus bare-word
        // args — the type check alone excludes the name node.
        for (const child of cmdNode.namedChildren) {
          if (!child || child.type !== 'word') continue;
          const ref = resolveFileArg(child.text, path.dirname(abs), qnameOf);
          if (ref) edges.push({ from: scriptRef, to: ref, relation: 'invokes', metadata: { line } });
        }
      }
    }
    return { nodes, edges };
  },
};
