import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import {
  endpointQName, eventChannelQName, httpCallQName, normalizeHttpMethod,
  normalizeRoutePath, normalizeServiceAlias, owningRegisteredRepo,
  parseLiteralHttpUrl, readEndpointMetadata, readHttpCallMetadata, routeMatches,
  serviceIdentity, serviceSourceQName, sourceQNameForPath,
} from '../graph/contracts.js';
import {
  canonicalPhysicalPath, canonicalRegisteredRoots, physicalPathAliases,
} from '../graph/roots.js';

const DB_URL = requireDisposableTestDbUrl();
process.env.MAI_TEST_DB_URL = DB_URL;
process.env.MAI_DB_URL = DB_URL;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-graph-contracts.mjs');
const PRIVATE_MARKER = path.join(ROOT, 'release', 'public');

export type CheckerAvailability = 'full' | 'public-artifact';
export function checkerAvailability(input: {
  checkerPresent: boolean;
  privateMarkerPresent: boolean;
}): CheckerAvailability {
  if (input.checkerPresent) return 'full';
  if (input.privateMarkerPresent) throw new Error('private graph-contract checker missing');
  return 'public-artifact';
}

const availability = checkerAvailability({
  checkerPresent: fs.existsSync(CHECKER),
  privateMarkerPresent: fs.existsSync(PRIVATE_MARKER),
});
const runChecker = (args: string[]) =>
  spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8' });

describe('graph-contract packaging boundary', () => {
  it('classifies all three private/public checker shapes', () => {
    expect(checkerAvailability({ checkerPresent: true, privateMarkerPresent: true })).toBe('full');
    expect(checkerAvailability({ checkerPresent: true, privateMarkerPresent: false })).toBe('full');
    expect(checkerAvailability({ checkerPresent: false, privateMarkerPresent: false })).toBe('public-artifact');
    expect(() => checkerAvailability({ checkerPresent: false, privateMarkerPresent: true }))
      .toThrow('private graph-contract checker missing');
  });

  it('proves the classification with real temporary source shapes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-package-'));
    try {
      const marker = path.join(temp, 'release', 'public');
      fs.mkdirSync(marker, { recursive: true });
      expect(() => checkerAvailability({ checkerPresent: false, privateMarkerPresent: fs.existsSync(marker) }))
        .toThrow('private graph-contract checker missing');
      fs.rmSync(path.join(temp, 'release'), { recursive: true });
      expect(checkerAvailability({ checkerPresent: false, privateMarkerPresent: fs.existsSync(marker) }))
        .toBe('public-artifact');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(availability === 'public-artifact')('graph-contract private checker', () => {
  it('passes the Task 1 stage and its fail-closed self-test', () => {
    const checkerBefore = fs.readFileSync(CHECKER);
    const stage = runChecker(['--stage', 'task1']);
    expect(stage.status, stage.stderr).toBe(0);
    expect(stage.stdout).toContain('graph-contract task1 OK');
    const self = runChecker(['--self-test']);
    expect(self.status, self.stderr).toBe(0);
    expect(self.stdout).toContain('graph-contract self-test OK');
    const mutations = runChecker(['--mutation-test']);
    expect(mutations.status, mutations.stderr).toBe(0);
    expect(mutations.stdout).toContain('287 mutants rejected by name');
    const privacy = runChecker(['--privacy-receipt']);
    expect(privacy.status, privacy.stderr).toBe(0);
    expect(privacy.stdout).toContain('HttpCallMetadata keys: contract,source_service,target_host,method,path');
    expect(privacy.stdout).toContain('EndpointMetadata keys: contract,service_id,service_aliases,method,path');
    expect(privacy.stdout).toContain('identity files: package.json,composer.json,pyproject.toml');
    expect(privacy.stdout).toContain('executable env/secret/network reads: 0');
    expect(fs.readFileSync(CHECKER)).toEqual(checkerBefore);
  }, 180_000);

  it('passes the Task 3 Python producer census', () => {
    const stage = runChecker(['--stage', 'task3']);
    expect(stage.status, stage.stderr).toBe(0);
    expect(stage.stdout).toContain('graph-contract task3 OK');
  });

  it('passes the final Task 4 linker and orchestration census', () => {
    const checkerBefore = fs.readFileSync(CHECKER);
    const final = runChecker([]);
    expect(final.status, final.stderr).toBe(0);
    expect(final.stdout).toContain('graph-contract final OK');
    expect(fs.readFileSync(CHECKER)).toEqual(checkerBefore);
  });
});

describe('service contract identities and normalization', () => {
  it('normalizes aliases, methods, routes, URLs, and bounded placeholders', () => {
    expect(normalizeServiceAlias(' Foo_bar / API ')).toBe('foo-bar-api');
    expect(normalizeServiceAlias('---')).toBeNull();
    for (const method of ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(normalizeHttpMethod(method.toLowerCase())).toBe(method);
    }
    expect(normalizeHttpMethod('TRACE')).toBeNull();
    expect(normalizeRoutePath('//v1/users/:id/?q=secret#x')).toBe('/v1/users/{}');
    expect(normalizeRoutePath('/files/[...rest]')).toBe('/files/{**}');
    expect(normalizeRoutePath('/files/<path:name>/done')).toBe('/files/{**}/done');
    for (const route of [
      '/users/:id', '/users/{id}', '/users/[id]', '/users/<name>',
      '/users/<string:name>', '/users/<int:id>', '/users/<float:value>',
      '/users/<uuid:id>', '/users/<any(red,blue):kind>',
    ]) expect(normalizeRoutePath(route)).toBe('/users/{}');
    expect(normalizeRoutePath('/x/<regex(foo):id>')).toBeNull();
    expect(normalizeRoutePath('/literal/prefix:id/suffix')).toBe('/literal/prefix:id/suffix');
    expect(normalizeRoutePath('/')).toBe('/');
    expect(normalizeRoutePath('/health/')).toBe('/health');
    expect(normalizeRoutePath('/bad\u0000route')).toBeNull();
    expect(parseLiteralHttpUrl('HTTPS://LOCALHOST:8443/a//b?q=secret#fragment')).toEqual({
      host: 'localhost', methodPath: '/a/b',
    });
    expect(parseLiteralHttpUrl('https://user:pass@example.com/private')).toBeNull();
    expect(parseLiteralHttpUrl('ftp://example.com/a')).toBeNull();
    expect(parseLiteralHttpUrl('http://127.0.0.1:9000/a')).toEqual({ host: '127.0.0.1', methodPath: '/a' });
    expect(parseLiteralHttpUrl('http://[::1]:9000/a')).toEqual({ host: '[::1]', methodPath: '/a' });
  });

  it('matches one-segment and backtracking catch-all routes without zero segments', () => {
    expect(routeMatches('/users/{}', '/users/42')).toBe(true);
    expect(routeMatches('/users/{}', '/users/a/b')).toBe(false);
    expect(routeMatches('/files/{**}/done', '/files/a/b/done')).toBe(true);
    expect(routeMatches('/files/{**}/done', '/files/done')).toBe(false);
    expect(routeMatches('/{**}/tail', '/a/tail/tail')).toBe(true);
    expect(routeMatches('/{**}/tail', '/tail')).toBe(false);
    expect(routeMatches('/a/{**}/b/{}/c', '/a/x/y/b/z/c')).toBe(true);
    expect(routeMatches('/a/{**}/b/{}/c', '/a/b/z/c')).toBe(false);
  });

  it('creates stable path-digest service and qualified identities', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-id-'));
    try {
      const one = path.join(temp, 'a', 'same_name');
      const two = path.join(temp, 'b', 'same-name');
      const empty = path.join(temp, '---');
      for (const dir of [one, two, empty]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(one, 'package.json'), JSON.stringify({ name: '@scope/Client_API' }));
      fs.writeFileSync(path.join(one, 'composer.json'), JSON.stringify({ name: 'vendor/Php.Api' }));
      fs.writeFileSync(path.join(one, 'pyproject.toml'), '[project]\nname = "Py Api"\n');
      const first = serviceIdentity(one);
      const again = serviceIdentity(path.join(one, '.'));
      const second = serviceIdentity(two);
      const punctuation = serviceIdentity(empty);
      expect(first).toEqual(again);
      expect(first.id).not.toBe(second.id);
      expect(punctuation.id).toMatch(/^service-[0-9a-f]{12}$/);
      expect(first.aliases).toEqual(['client-api', 'php-api', 'py-api', 'same-name']);
      expect(endpointQName(first.id, 'GET', '/health')).not.toBe(endpointQName(second.id, 'GET', '/health'));
      const file = serviceSourceQName(first.id, 'file:src/index.ts');
      expect(serviceSourceQName(first.id, file)).toBe(file);
      expect(sourceQNameForPath(first.id, 'file:x.ts', '.ts')).toContain('service-source:');
      expect(sourceQNameForPath(first.id, 'script:x.sh', '.sh')).toBe('script:x.sh');
      expect(httpCallQName(first.id, file, 4, 8)).toContain(`${first.id}:${file}:4:8`);
      expect(eventChannelQName('kafka', 'orders.created')).toBe('event:kafka:orders.created');
      expect(() => serviceIdentity('relative')).toThrow('must be absolute');
      const link = path.join(temp, 'alias');
      fs.symlinkSync(one, link, 'dir');
      expect(serviceIdentity(link)).toEqual(first);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('accepts only exact privacy-safe metadata contracts', () => {
    const call = {
      contract: 'http-call-v1', source_service: 'client-a', target_host: 'api',
      method: 'GET', path: '/users/{}',
    };
    const endpoint = {
      contract: 'http-endpoint-v1', service_id: 'api-a', service_aliases: ['api'],
      method: 'ANY', path: '/users/{}',
    };
    expect(readHttpCallMetadata(call)).toEqual(call);
    expect(readEndpointMetadata(endpoint)).toEqual(endpoint);
    expect(readHttpCallMetadata({ ...call, raw_url: 'https://api/users/1?token=x' })).toBeNull();
    expect(readEndpointMetadata({ ...endpoint, headers: {} })).toBeNull();
    expect(readHttpCallMetadata([])).toBeNull();
    expect(readHttpCallMetadata({ ...call, method: 'TRACE' })).toBeNull();
    expect(readHttpCallMetadata({ ...call, path: '/users/:id' })).toBeNull();
    expect(readHttpCallMetadata({ ...call, target_host: 'bad\u0000host' })).toBeNull();
    expect(readEndpointMetadata(null)).toBeNull();
    expect(readEndpointMetadata({ ...endpoint, contract: 'http-endpoint-v2' })).toBeNull();
    expect(readEndpointMetadata({ ...endpoint, service_aliases: ['Not_Normalized'] })).toBeNull();
  });
});

describe('physical root ownership', () => {
  it('dedupes symlink/dot aliases and selects the longest physical owner', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-root-'));
    try {
      const parent = path.join(temp, 'parent');
      const child = path.join(parent, 'child');
      const link = path.join(temp, 'alias');
      fs.mkdirSync(child, { recursive: true });
      fs.symlinkSync(parent, link, 'dir');
      const roots = canonicalRegisteredRoots([parent, path.join(parent, '.'), link], {
        baseDir: temp, rejectRelative: true,
      });
      expect(roots).toEqual([canonicalPhysicalPath(parent, temp)]);
      const physicalParent = canonicalPhysicalPath(parent, temp);
      const physicalChild = canonicalPhysicalPath(child, temp);
      expect(owningRegisteredRepo(path.join(physicalChild, 'src', 'x.ts'), [physicalParent, physicalChild]))
        .toBe(physicalChild);
      expect(owningRegisteredRepo('/foreign/x.ts', [physicalParent, physicalChild])).toBeNull();
      const aliases = physicalPathAliases([parent, link], { baseDir: temp, rejectRelative: true });
      expect(aliases.rawToPhysical.get(link)).toBe(physicalParent);
      expect(() => canonicalRegisteredRoots(['relative'], { baseDir: temp, rejectRelative: true }))
        .toThrow('must be absolute');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

const admin = new Pool({ connectionString: DB_URL });
let project = '';

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug LIKE 'graph-contract-gate-%'`);
  const row = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('graph-contract-gate-a', 'A', $1, jsonb_build_object('repos', jsonb_build_array($1::text)))
     RETURNING id`,
    [ROOT],
  );
  project = row.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug LIKE 'graph-contract-gate-%'`);
  await admin.end();
  const { closePool } = await import('../db.js');
  await closePool();
});

describe('engine contract tallies and shared endpoint ownership', () => {
  it('counts nested-repo nodes only against their longest-prefix physical owner', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-contract-freshness-'));
    const parent = path.join(temp, 'umbrella');
    const child = path.join(parent, 'service-api');
    const git = (cwd: string, args: string[]): string => {
      const result = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
      return result.stdout.trim();
    };
    let nestedProject = '';
    try {
      fs.mkdirSync(child, { recursive: true });
      git(parent, ['init', '-q']);
      fs.writeFileSync(path.join(parent, 'parent.txt'), 'parent\n');
      git(parent, ['add', 'parent.txt']);
      git(parent, ['commit', '-qm', 'parent']);
      git(child, ['init', '-q']);
      const childSource = 'export const child = 1;\n';
      fs.writeFileSync(path.join(child, 'child.ts'), childSource);
      git(child, ['add', 'child.ts']);
      git(child, ['commit', '-qm', 'child']);
      const childHead = git(child, ['rev-parse', 'HEAD']);
      const physicalChild = fs.realpathSync.native(child);
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata)
         VALUES ('graph-contract-gate-nested', 'Nested', $1,
           jsonb_build_object('repos', jsonb_build_array($1::text, $2::text))) RETURNING id`,
        [parent, child],
      );
      nestedProject = inserted.rows[0].id;
      await admin.query(
        `INSERT INTO graph_nodes
           (project_id, kind, name, qualified_name, file_path, commit_sha, extracted_by, content_hash)
         VALUES ($1, 'file', 'child.ts', 'service-source:child:file:child.ts', $2, $3, 'ts', $4)`,
        [nestedProject, path.join(physicalChild, 'child.ts'), childHead,
          createHash('sha256').update(childSource).digest('hex')],
      );
      const { graphStaleCounts } = await import('../graph/freshness.js');
      const { graphStale } = await import('../graph/query.js');
      expect(await graphStaleCounts(nestedProject)).toEqual({ total: 1, stale: 0, method: 'per-file' });
      const rendered = await graphStale({ projectId: nestedProject });
      expect(rendered).toContain(`## ${path.basename(parent)} — 0/0 stale`);
      expect(rendered).toContain(`## ${path.basename(child)} — 0/1 stale`);
    } finally {
      if (nestedProject) await admin.query(`DELETE FROM projects WHERE id = $1`, [nestedProject]);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('defaults omitted tallies to zero and validates supplied values', async () => {
    const { runExtractor, spliceExtractor } = await import('../graph/engine.js');
    const base = {
      name: 'contract-tally',
      vocabulary: { kinds: ['file'] as const, relations: [] as const },
    };
    const zero = await runExtractor({ ...base, extract: async () => ({ nodes: [], edges: [] }) }, {
      projectId: project, repoPaths: [ROOT],
    });
    expect(zero.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
    const one = await runExtractor({ ...base, extract: async () => ({
      nodes: [], edges: [], contractSkips: {
        dynamic_http_url: 1, dynamic_http_method: 0,
        dynamic_http_route: 0, dynamic_event_channel: 0,
      },
    }) }, { projectId: project, repoPaths: [ROOT] });
    expect(one.contractSkips.dynamic_http_url).toBe(1);
    const invalidValues = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const invalid of invalidValues) {
      const tallies = {
        dynamic_http_url: 0, dynamic_http_method: 0,
        dynamic_http_route: 0, dynamic_event_channel: 0,
      };
      Reflect.set(tallies, 'dynamic_http_url', invalid);
      await expect(runExtractor({ ...base, extract: async () => ({
        nodes: [], edges: [], contractSkips: tallies,
      }) }, { projectId: project, repoPaths: [ROOT] })).rejects.toThrow('invalid contract skip tally');
    }
    const missing = {
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    };
    Reflect.deleteProperty(missing, 'dynamic_http_url');
    await expect(runExtractor({ ...base, extract: async () => ({
      nodes: [], edges: [], contractSkips: missing,
    }) }, { projectId: project, repoPaths: [ROOT] })).rejects.toThrow('invalid contract skip keys');
    const extra = {
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    };
    Reflect.set(extra, 'extra', 0);
    await expect(runExtractor({ ...base, extract: async () => ({
      nodes: [], edges: [], contractSkips: extra,
    }) }, { projectId: project, repoPaths: [ROOT] })).rejects.toThrow('invalid contract skip keys');
    const splice = await spliceExtractor({ ...base, extract: async () => ({ nodes: [], edges: [] }) }, {
      projectId: project, repoPaths: [ROOT], changedFiles: [], deletedFiles: [],
    });
    expect(splice.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('does not let stale http_calls or foreign ownership preserve an endpoint', async () => {
    const { sweepOrphanSharedNodes } = await import('../graph/engine.js');
    const foreign = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path, metadata)
       VALUES ('graph-contract-gate-b', 'B', $1, jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`,
      [ROOT],
    );
    const rows = await admin.query<{ id: string; qualified_name: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
       VALUES ($1, 'endpoint', 'GET /x', 'endpoint:a:GET:/x', 'seed'),
              ($1, 'http_call', 'call', 'http-call:a:f:1:1', 'seed'),
              ($2, 'file', 'foreign', 'foreign:file', 'seed')
       RETURNING id, qualified_name`,
      [project, foreign.rows[0].id],
    );
    const endpoint = rows.rows.find((row) => row.qualified_name.startsWith('endpoint:'))?.id;
    const call = rows.rows.find((row) => row.qualified_name.startsWith('http-call:'))?.id;
    const foreignFile = rows.rows.find((row) => row.qualified_name === 'foreign:file')?.id;
    if (!endpoint || !call || !foreignFile) throw new Error('seed ids missing');
    await admin.query(
      `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
       VALUES ($1, $2, $3, 'http_calls', 'extracted'),
              ($4, $5, $3, 'serves_route', 'extracted')`,
      [project, call, endpoint, foreign.rows[0].id, foreignFile],
    );
    await sweepOrphanSharedNodes(project);
    const remaining = await admin.query(`SELECT 1 FROM graph_nodes WHERE id = $1`, [endpoint]);
    expect(remaining.rowCount).toBe(0);

    const event = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
       VALUES ($1, 'event_channel', 'orders', 'event:kafka:orders', 'seed') RETURNING id`,
      [project],
    );
    await admin.query(
      `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
       VALUES ($1, $2, $3, 'emits', 'extracted')`,
      [foreign.rows[0].id, foreignFile, event.rows[0].id],
    );
    await sweepOrphanSharedNodes(project);
    const remainingEvent = await admin.query(`SELECT 1 FROM graph_nodes WHERE id = $1`, [event.rows[0].id]);
    expect(remainingEvent.rowCount).toBe(0);
  });

  it('keeps a shared endpoint until its last provider disappears, ignoring a stale caller edge', async () => {
    const { runExtractor, spliceExtractor, sweepOrphanSharedNodes } = await import('../graph/engine.js');
    const firstFile = path.join(ROOT, 'provider-one.ts');
    const secondFile = path.join(ROOT, 'provider-two.ts');
    const endpointQNameValue = 'endpoint:splice-service:GET:/shared';
    let providers = [firstFile, secondFile];
    const extractor = {
      name: 'contract-provider',
      vocabulary: { kinds: ['file', 'endpoint'] as const, relations: ['serves_route'] as const },
      extract: async () => ({
        nodes: [
          ...(providers.length > 0 ? [{
            kind: 'endpoint' as const,
            name: 'GET /shared',
            qualifiedName: endpointQNameValue,
          }] : []),
          ...providers.map((filePath) => ({
            kind: 'file' as const,
            name: path.basename(filePath),
            qualifiedName: `service-source:splice-service:file:${path.basename(filePath)}`,
            filePath,
          })),
        ],
        edges: providers.map((filePath) => ({
          from: { kind: 'file' as const, qualifiedName: `service-source:splice-service:file:${path.basename(filePath)}` },
          to: { kind: 'endpoint' as const, qualifiedName: endpointQNameValue },
          relation: 'serves_route' as const,
        })),
      }),
    };
    await runExtractor(extractor, { projectId: project, repoPaths: [ROOT] });
    providers = [secondFile];
    await spliceExtractor(extractor, {
      projectId: project, repoPaths: [ROOT], changedFiles: [], deletedFiles: [firstFile],
    });
    await sweepOrphanSharedNodes(project);
    const afterFirst = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM graph_nodes WHERE project_id = $1 AND qualified_name = $2`,
      [project, endpointQNameValue],
    );
    expect(afterFirst.rows[0].count).toBe('1');

    const endpoint = await admin.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE project_id = $1 AND qualified_name = $2`,
      [project, endpointQNameValue],
    );
    const caller = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
       VALUES ($1, 'http_call', 'stale call', 'http-call:splice:stale:1:1', 'seed') RETURNING id`,
      [project],
    );
    await admin.query(
      `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
       VALUES ($1, $2, $3, 'http_calls', 'linked')`,
      [project, caller.rows[0].id, endpoint.rows[0].id],
    );
    providers = [];
    await spliceExtractor(extractor, {
      projectId: project, repoPaths: [ROOT], changedFiles: [], deletedFiles: [secondFile],
    });
    await sweepOrphanSharedNodes(project);
    const afterLast = await admin.query(`SELECT 1 FROM graph_nodes WHERE id = $1`, [endpoint.rows[0].id]);
    const staleEdge = await admin.query(
      `SELECT 1 FROM graph_edges WHERE project_id = $1 AND relation = 'http_calls' AND to_node = $2`,
      [project, endpoint.rows[0].id],
    );
    expect(afterLast.rowCount).toBe(0);
    expect(staleEdge.rowCount).toBe(0);
  });
});
