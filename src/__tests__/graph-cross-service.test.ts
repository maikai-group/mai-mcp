import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const DB_URL = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = DB_URL;
process.env.MAI_TEST_DB_URL = DB_URL;

const admin = new Pool({ connectionString: DB_URL });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const slugs = [
  `graph-cross-service-a-${process.pid}`,
  `graph-cross-service-b-${process.pid}`,
  `graph-cross-service-build-${process.pid}`,
  `graph-cross-service-same-${process.pid}`,
  `graph-cross-service-nested-${process.pid}`,
];
let projectA = '';
let projectB = '';

interface NodeSeed {
  kind: 'endpoint' | 'http_call';
  qname: string;
  metadata: Record<string, unknown>;
}

async function insertNode(projectId: string, seed: NodeSeed): Promise<string> {
  const row = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes
       (project_id, kind, name, qualified_name, extracted_by, metadata)
     VALUES ($1, $2, $3, $4, 'cross-service-test', $5::jsonb)
     RETURNING id`,
    [projectId, seed.kind, seed.qname, seed.qname, JSON.stringify(seed.metadata)],
  );
  return row.rows[0].id;
}

function endpoint(
  qname: string,
  serviceId: string,
  aliases: string[],
  method: string,
  path: string,
): NodeSeed {
  return {
    kind: 'endpoint', qname,
    metadata: {
      contract: 'http-endpoint-v1', service_id: serviceId,
      service_aliases: aliases, method, path,
    },
  };
}

function call(
  qname: string,
  sourceService: string,
  host: string,
  method: string,
  path: string,
): NodeSeed {
  return {
    kind: 'http_call', qname,
    metadata: {
      contract: 'http-call-v1', source_service: sourceService,
      target_host: host, method, path,
    },
  };
}

async function edges(projectId: string): Promise<Array<{ from_qname: string; to_qname: string }>> {
  const rows = await admin.query<{ from_qname: string; to_qname: string }>(
    `SELECT caller.qualified_name AS from_qname, endpoint.qualified_name AS to_qname
     FROM graph_edges edge
     JOIN graph_nodes caller ON caller.id = edge.from_node AND caller.project_id = edge.project_id
     JOIN graph_nodes endpoint ON endpoint.id = edge.to_node AND endpoint.project_id = edge.project_id
     WHERE edge.project_id = $1 AND edge.relation = 'http_calls'
     ORDER BY caller.qualified_name, endpoint.qualified_name`,
    [projectId],
  );
  return rows.rows;
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = ANY($1)`, [slugs]);
  const rows = await admin.query<{ id: string; slug: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ($1, $1, $3, '{}'::jsonb), ($2, $2, $3, '{}'::jsonb)
     RETURNING id, slug`,
    [slugs[0], slugs[1], process.cwd()],
  );
  const rowA = rows.rows.find((row) => row.slug === slugs[0]);
  const rowB = rows.rows.find((row) => row.slug === slugs[1]);
  if (rowA === undefined || rowB === undefined) throw new Error('cross-service projects were not created');
  projectA = rowA.id;
  projectB = rowB.id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = ANY($1)`, [slugs]);
  await admin.end();
  const { closePool } = await import('../db.js');
  await closePool();
});

describe.sequential('project-local service contract linker', () => {
  it('matches route before method and applies exact-over-ANY and caller-ANY rules', async () => {
    const { linkServiceContracts } = await import('../graph/linker.js');
    await admin.query(`DELETE FROM graph_nodes WHERE project_id = $1`, [projectA]);
    await insertNode(projectA, endpoint('endpoint:api:get-other', 'api-service', ['api'], 'POST', '/other'));
    await insertNode(projectA, endpoint('endpoint:api:any-wanted', 'api-service', ['api'], 'ANY', '/wanted/{}'));
    await insertNode(projectA, endpoint('endpoint:api:get-wanted', 'api-service', ['api'], 'GET', '/wanted/{}'));
    await insertNode(projectA, endpoint('endpoint:api:post-only', 'api-service', ['api'], 'POST', '/post-only'));
    await insertNode(projectA, call('call:post-fallback', 'client-service', 'api.internal', 'POST', '/wanted/42'));
    await insertNode(projectA, call('call:get-exact', 'client-service', 'api.internal', 'GET', '/wanted/42'));
    await insertNode(projectA, call('call:any', 'client-service', 'api.internal', 'ANY', '/wanted/42'));
    await insertNode(projectA, call('call:unmatched', 'client-service', 'api.internal', 'GET', '/post-only'));
    await insertNode(projectA, call('call:same-service', 'api-service', 'api.internal', 'GET', '/wanted/42'));

    await expect(linkServiceContracts(projectA)).resolves.toEqual({
      linked: 3, unresolved: 2, ambiguous: 0,
    });
    expect(await edges(projectA)).toEqual([
      { from_qname: 'call:any', to_qname: 'endpoint:api:any-wanted' },
      { from_qname: 'call:get-exact', to_qname: 'endpoint:api:get-wanted' },
      { from_qname: 'call:post-fallback', to_qname: 'endpoint:api:any-wanted' },
    ]);
  });

  it('counts alias and endpoint multiplicity as ambiguous without cross-project influence', async () => {
    const { linkServiceContracts } = await import('../graph/linker.js');
    await admin.query(`DELETE FROM graph_nodes WHERE project_id IN ($1, $2)`, [projectA, projectB]);
    await insertNode(projectA, endpoint('endpoint:a:one', 'api-one', ['shared'], 'GET', '/x'));
    await insertNode(projectA, endpoint('endpoint:a:two', 'api-two', ['shared'], 'GET', '/x'));
    await insertNode(projectA, endpoint('endpoint:a:duplicate-1', 'unique-api', ['unique'], 'GET', '/same'));
    await insertNode(projectA, endpoint('endpoint:a:duplicate-2', 'unique-api', ['unique'], 'GET', '/same'));
    await insertNode(projectA, call('call:alias-ambiguous', 'client', 'shared', 'GET', '/x'));
    await insertNode(projectA, call('call:endpoint-ambiguous', 'client', 'unique', 'GET', '/same'));
    await insertNode(projectB, endpoint('endpoint:b:foreign', 'foreign-api', ['foreign'], 'GET', '/foreign'));
    await insertNode(projectA, call('call:foreign-host', 'client', 'foreign', 'GET', '/foreign'));

    await expect(linkServiceContracts(projectA)).resolves.toEqual({
      linked: 0, unresolved: 1, ambiguous: 2,
    });
    expect(await edges(projectA)).toEqual([]);
    expect(await edges(projectB)).toEqual([]);
  });

  it('atomically replaces stale edges and rolls the delete back when an insert fails', async () => {
    const { linkServiceContracts } = await import('../graph/linker.js');
    await admin.query(`DELETE FROM graph_nodes WHERE project_id = $1`, [projectA]);
    const oldCall = await insertNode(projectA, call('call:old', 'client', 'api', 'GET', '/old'));
    const oldEndpoint = await insertNode(projectA, endpoint('endpoint:old', 'api-service', ['api'], 'GET', '/old'));
    await admin.query(
      `INSERT INTO graph_edges
         (project_id, from_node, to_node, relation, confidence, weight, metadata)
       VALUES ($1, $2, $3, 'http_calls', 'extracted', 1, '{"matcher":"literal-v1"}'::jsonb)`,
      [projectA, oldCall, oldEndpoint],
    );
    await admin.query(`UPDATE graph_nodes SET metadata = jsonb_set(metadata, '{path}', '"/new"') WHERE id = $1`, [oldCall]);
    const newEndpoint = await insertNode(projectA, endpoint('endpoint:new', 'api-service', ['api'], 'GET', '/new'));
    const suffix = `${process.pid}_${Date.now()}`;
    const functionName = `graph_contract_fail_${suffix}`;
    const triggerName = `graph_contract_fail_${suffix}`;
    try {
      await admin.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.project_id = '${projectA}'::uuid AND NEW.relation = 'http_calls'
              AND NEW.to_node = '${newEndpoint}'::uuid THEN
             RAISE EXCEPTION 'injected http linker failure';
           END IF;
           RETURN NEW;
         END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON graph_edges
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      await expect(linkServiceContracts(projectA)).rejects.toThrow('injected http linker failure');
      expect(await edges(projectA)).toEqual([
        { from_qname: 'call:old', to_qname: 'endpoint:old' },
      ]);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS ${triggerName} ON graph_edges`);
      await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    await expect(linkServiceContracts(projectA)).resolves.toEqual({
      linked: 1, unresolved: 0, ambiguous: 0,
    });
    expect(await edges(projectA)).toEqual([
      { from_qname: 'call:old', to_qname: 'endpoint:new' },
    ]);
  });
});

describe.sequential('cross-service build and update convergence', () => {
  it('dedupes physical aliases, relinks changed calls, and refreshes excluded identity manifests', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-cross-service-build-')));
    const services = path.join(temp, 'services');
    const fixture = path.join(ROOT, 'src', '__tests__', 'fixtures', 'cross-service');
    const repos = ['ts-client', 'python-api', 'php-api'].map((name) => path.join(services, name));
    const git = (repo: string, args: string[]): string => {
      const result = spawnSync('git', [
        '-C', repo, '-c', 'user.email=cross-service@test.invalid',
        '-c', 'user.name=CrossService', ...args,
      ], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
      return result.stdout.trim();
    };
    let integrationProject = '';
    try {
      fs.mkdirSync(services, { recursive: true });
      for (const repo of repos) {
        fs.cpSync(path.join(fixture, path.basename(repo)), repo, { recursive: true });
        if (path.basename(repo) === 'ts-client') {
          fs.appendFileSync(
            path.join(repo, 'src', 'client.ts'),
            "\nvoid fetch('https://python-public/health');\nvoid fetch('https://python-renamed/health');\n",
          );
          fs.writeFileSync(path.join(repo, 'src', 'worker.ts'), 'export const worker = true;\n');
          fs.writeFileSync(path.join(repo, 'src', 'worker.php'), '<?php echo "worker";\n');
          fs.writeFileSync(path.join(repo, 'src', 'worker.py'), 'print("worker one")\n');
          fs.writeFileSync(path.join(repo, 'src', 'worker.go'), 'package main\nfunc main() {}\n');
          fs.writeFileSync(path.join(repo, 'src', 'behavior-peer.ts'), 'export const peer = 1;\n');
          fs.writeFileSync(
            path.join(repo, 'run-worker.sh'),
            [
              '#!/usr/bin/env bash',
              'node ./src/worker.ts',
              'php ./src/worker.php',
              'python3 ./src/worker.py',
              'go run ./src/worker.go',
              '',
            ].join('\n'),
          );
          const packageJsonPath = path.join(repo, 'package.json');
          const packageJson: Record<string, unknown> = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          packageJson.scripts = { 'run-php-worker': 'php src/worker.php' };
          fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
          fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
          fs.writeFileSync(
            path.join(repo, '.claude', 'settings.json'),
            `${JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ command: 'python3 src/worker.py' }] }] } }, null, 2)}\n`,
          );
        }
        if (path.basename(repo) === 'python-api') {
          const manifestPath = path.join(repo, 'pyproject.toml');
          fs.writeFileSync(
            manifestPath,
            fs.readFileSync(manifestPath, 'utf8').replace('name = "python-api"', 'name = "python-public"'),
          );
        }
        git(repo, ['init', '-q']);
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'fixture']);
      }
      fs.writeFileSync(path.join(repos[0], 'src', 'worker.py'), 'print("worker two")\n');
      fs.writeFileSync(path.join(repos[0], 'src', 'behavior-peer.ts'), 'export const peer = 2;\n');
      git(repos[0], ['add', 'src/worker.py', 'src/behavior-peer.ts']);
      git(repos[0], ['commit', '-qm', 'second behavioral co-change']);
      const tsAlias = path.join(temp, 'ts-alias');
      fs.symlinkSync(repos[0], tsAlias, 'dir');
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata)
         VALUES ($1, $1, $2, jsonb_build_object(
           'repos', jsonb_build_array($3::text, $4::text, $5::text, $6::text, $7::text),
           'graph_excludes', '[]'::jsonb
         )) RETURNING id`,
        [slugs[2], temp, repos[0], path.join(repos[0], '.'), tsAlias, repos[1], repos[2]],
      );
      integrationProject = inserted.rows[0].id;

      const { runGraphBuild } = await import('../graph/build.js');
      const { runGraphUpdate } = await import('../graph/update.js');
      const build = await runGraphBuild({ projectId: integrationProject, slug: slugs[2] });
      expect(build.split('\n')[0]).toBe(`# mai graph build — ${slugs[2]}`);
      expect(build.match(/^- ts:.*; dynamic contracts skipped url=0 method=0 route=0 channel=0$/gm)).toHaveLength(1);
      expect(build.match(/^- php:.*; dynamic contracts skipped url=0 method=0 route=0 channel=0$/gm)).toHaveLength(1);
      expect(build.match(/^- python:.*; dynamic contracts skipped url=0 method=0 route=0 channel=0$/gm)).toHaveLength(1);
      expect(build).toMatch(/- linker: \d+ HTTP calls linked \(\d+ unresolved, \d+ ambiguous\)/);
      expect(build).not.toContain('token=discarded');
      expect(build).not.toContain('ignored.invalid');

      const sourceRows = await admin.query<{ qualified_name: string; file_path: string }>(
        `SELECT qualified_name, file_path FROM graph_nodes
         WHERE project_id = $1 AND kind = 'file'
           AND (right(file_path, 3) IN ('.ts', '.py') OR right(file_path, 4) = '.php')`,
        [integrationProject],
      );
      expect(sourceRows.rows.length).toBeGreaterThan(0);
      expect(sourceRows.rows.every((row) => row.qualified_name.startsWith('service-source:'))).toBe(true);
      expect(new Set(sourceRows.rows.map((row) => row.file_path)).size).toBe(sourceRows.rows.length);
      const relationCounts = await admin.query<{ relation: string; count: string }>(
        `SELECT relation, COUNT(*)::text AS count FROM graph_edges
         WHERE project_id = $1 AND relation = ANY($2)
         GROUP BY relation ORDER BY relation`,
        [integrationProject, ['http_calls', 'emits', 'listens_on', 'serves_route']],
      );
      const counts = new Map(relationCounts.rows.map((row) => [row.relation, Number(row.count)]));
      expect(counts.get('http_calls')).toBeGreaterThan(0);
      expect(counts.get('emits')).toBeGreaterThan(0);
      expect(counts.get('listens_on')).toBeGreaterThan(0);
      expect(counts.get('serves_route')).toBeGreaterThan(0);
      const tsService = await admin.query<{ service_id: string }>(
        `SELECT metadata->>'source_service' AS service_id FROM graph_nodes
         WHERE project_id = $1 AND kind = 'http_call'
           AND metadata->>'target_host' = 'python-renamed'
         ORDER BY qualified_name LIMIT 1`,
        [integrationProject],
      );
      expect(tsService.rows).toHaveLength(1);
      const tsServiceId = tsService.rows[0].service_id;

      type ObservedEdge = {
        from: { kind: string; qualifiedName: string };
        to: { kind: string; qualifiedName: string };
        relation: string;
      };
      const { shellExtractor } = await import('../graph/extractors/shell.js');
      const { glueExtractor } = await import('../graph/extractors/glue.js');
      const { behavioralExtractor } = await import('../graph/extractors/behavioral.js');
      const shellObservation = await shellExtractor.extract({
        projectId: integrationProject, repoPaths: repos, excludes: [],
      });
      const glueObservation = await glueExtractor.extract({
        projectId: integrationProject, repoPaths: repos, excludes: [],
      });
      const behavioralObservation = await behavioralExtractor.extract({
        projectId: integrationProject, repoPaths: repos, excludes: [],
      });
      const requiredEdge = (edges: ObservedEdge[], predicate: (edge: ObservedEdge) => boolean, label: string): ObservedEdge => {
        const edge = edges.find(predicate);
        expect(edge, label).toBeDefined();
        if (edge === undefined) throw new Error(`${label} observation missing`);
        return edge;
      };
      const shellEdges = [
        ['worker.ts', 'shell→worker.ts'],
        ['worker.php', 'shell→worker.php'],
        ['worker.py', 'shell→worker.py'],
        ['worker.go', 'shell→worker.go'],
      ].map(([target, label]) => requiredEdge(
        shellObservation.edges,
        (edge) => edge.relation === 'invokes'
          && edge.from.qualifiedName.includes('run-worker.sh')
          && edge.to.qualifiedName.includes(target),
        label,
      ));
      const glueInvoke = requiredEdge(
        glueObservation.edges,
        (edge) => edge.relation === 'invokes'
          && edge.from.qualifiedName.includes('package.json#run-php-worker')
          && edge.to.qualifiedName.includes('worker.php'),
        'glue package-script→PHP',
      );
      const glueScheduledInvoke = requiredEdge(
        glueObservation.edges,
        (edge) => edge.relation === 'invokes'
          && edge.from.qualifiedName.includes('hook:ts-client:SessionEnd#0')
          && edge.to.qualifiedName.includes('worker.py'),
        'glue scheduled-job→Python',
      );
      const glueScheduledBy = requiredEdge(
        glueObservation.edges,
        (edge) => edge.relation === 'scheduled_by'
          && edge.from.qualifiedName.includes('worker.py')
          && edge.to.qualifiedName.includes('hook:ts-client:SessionEnd#0'),
        'glue Python→scheduled-job',
      );
      const behavioralEdge = requiredEdge(
        behavioralObservation.edges,
        (edge) => edge.relation === 'co_changed_with'
          && [edge.from.qualifiedName, edge.to.qualifiedName].some((value) => value.includes('behavior-peer.ts'))
          && [edge.from.qualifiedName, edge.to.qualifiedName].some((value) => value.includes('worker.py')),
        'behavioral TypeScript↔Python',
      );
      const observedEdges = [...shellEdges, glueInvoke, glueScheduledInvoke, glueScheduledBy, behavioralEdge];
      const persistedEdgeCount = async (edge: ObservedEdge): Promise<number> => {
        const result = await admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM graph_edges edge
           JOIN graph_nodes source ON source.id = edge.from_node AND source.project_id = edge.project_id
           JOIN graph_nodes target ON target.id = edge.to_node AND target.project_id = edge.project_id
           WHERE edge.project_id = $1 AND edge.relation = $2
             AND source.kind = $3 AND source.qualified_name = $4
             AND target.kind = $5 AND target.qualified_name = $6`,
          [
            integrationProject,
            edge.relation,
            edge.from.kind, edge.from.qualifiedName,
            edge.to.kind, edge.to.qualifiedName,
          ],
        );
        return Number(result.rows[0].count);
      };
      for (const edge of observedEdges) expect(await persistedEdgeCount(edge)).toBe(1);

      const targetEdges = new Map([
        ['worker.ts', [shellEdges[0]]],
        ['worker.php', [shellEdges[1], glueInvoke]],
        ['worker.py', [shellEdges[2], glueScheduledInvoke, glueScheduledBy, behavioralEdge]],
        ['worker.go', [shellEdges[3]]],
      ]);
      for (const [target, affectedEdges] of targetEdges) {
        const targetPath = path.join(repos[0], 'src', target);
        const targetText = fs.readFileSync(targetPath, 'utf8');
        fs.rmSync(targetPath);
        git(repos[0], ['add', '-A']);
        git(repos[0], ['commit', '-qm', `delete ${target} target only`]);
        const targetDeleted = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
        expect(targetDeleted).toMatch(/^- shell:.*full re-run — target graph finalized/m);
        for (const edge of affectedEdges) expect(await persistedEdgeCount(edge)).toBe(0);

        fs.writeFileSync(targetPath, targetText);
        git(repos[0], ['add', `src/${target}`]);
        git(repos[0], ['commit', '-qm', `restore ${target} target only`]);
        const targetRestored = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
        expect(targetRestored).toMatch(/^- shell:.*full re-run — target graph finalized/m);
        for (const edge of affectedEdges) expect(await persistedEdgeCount(edge)).toBe(1);
      }

      const clientPath = path.join(repos[0], 'src', 'client.ts');
      const originalClient = fs.readFileSync(clientPath, 'utf8');
      const callsBefore = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM graph_nodes WHERE project_id = $1 AND kind = 'http_call'`,
        [integrationProject],
      );
      fs.writeFileSync(clientPath, `${originalClient.replace(
        "void fetch('https://python-api/users/42?token=discarded#fragment');",
        "void fetch('https://python-api/health');",
      )}\nconst sensitiveDynamicEndpoint = getUrl();\nvoid fetch(sensitiveDynamicEndpoint);\n`);
      git(repos[0], ['add', 'src/client.ts']);
      git(repos[0], ['commit', '-qm', 'change literal target']);
      const changed = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(changed).toMatch(/^- ts:.*; dynamic contracts skipped url=1 method=0 route=0 channel=0$/m);
      expect(changed).toMatch(/^- php:.*; dynamic contracts skipped url=0 method=0 route=0 channel=0$/m);
      expect(changed).not.toContain('sensitiveDynamicEndpoint');
      expect(changed).toMatch(/^- shell:.*full re-run — target graph finalized/m);
      expect(changed).toMatch(/- linker: \d+ HTTP calls linked/);

      fs.writeFileSync(clientPath, originalClient.replace(/^void (?:fetch|axios).*$/gm, ''));
      git(repos[0], ['add', 'src/client.ts']);
      git(repos[0], ['commit', '-qm', 'remove literal clients']);
      await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      const callsAfterRemoval = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM graph_nodes WHERE project_id = $1 AND kind = 'http_call'`,
        [integrationProject],
      );
      expect(Number(callsAfterRemoval.rows[0].count)).toBeLessThan(Number(callsBefore.rows[0].count));
      const removedClientRelations = await admin.query<{ calls: string; defines: string; links: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM graph_nodes
            WHERE project_id = $1 AND kind = 'http_call'
              AND metadata->>'source_service' = $2) AS calls,
           (SELECT COUNT(*)::text FROM graph_edges edge
            JOIN graph_nodes target ON target.id = edge.to_node AND target.project_id = edge.project_id
            WHERE edge.project_id = $1 AND edge.relation = 'defines'
              AND target.kind = 'http_call'
              AND target.metadata->>'source_service' = $2) AS defines,
           (SELECT COUNT(*)::text FROM graph_edges edge
            JOIN graph_nodes caller ON caller.id = edge.from_node AND caller.project_id = edge.project_id
            WHERE edge.project_id = $1 AND edge.relation = 'http_calls'
              AND caller.kind = 'http_call'
              AND caller.metadata->>'source_service' = $2) AS links`,
        [integrationProject, tsServiceId],
      );
      expect(removedClientRelations.rows[0]).toEqual({ calls: '0', defines: '0', links: '0' });

      fs.writeFileSync(clientPath, originalClient);
      git(repos[0], ['add', 'src/client.ts']);
      git(repos[0], ['commit', '-qm', 'restore literal clients']);
      await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      const callsAfterRestore = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM graph_nodes WHERE project_id = $1 AND kind = 'http_call'`,
        [integrationProject],
      );
      expect(callsAfterRestore.rows[0].count).toBe(callsBefore.rows[0].count);

      const pythonPath = path.join(repos[1], 'app.py');
      const originalPython = fs.readFileSync(pythonPath, 'utf8');
      const linkedUserGets = async (): Promise<number> => {
        const result = await admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM graph_edges edge
           JOIN graph_nodes caller ON caller.id = edge.from_node AND caller.project_id = edge.project_id
           WHERE edge.project_id = $1 AND edge.relation = 'http_calls'
             AND caller.metadata->>'source_service' = $2
             AND caller.metadata->>'target_host' = 'python-api'
             AND caller.metadata->>'path' = '/users/42'`,
          [integrationProject, tsServiceId],
        );
        return Number(result.rows[0].count);
      };
      const linkedUserGetsBefore = await linkedUserGets();
      expect(linkedUserGetsBefore).toBeGreaterThan(0);
      const userEndpointBlock = /@app\.get\("\/users\/\{user_id\}"\)\ndef get_user\(\):\n    requests\.get\("https:\/\/php-api\/wp-json\/acme\/v1\/tip\?token=discarded"\)\n\n/;
      expect(originalPython).toMatch(userEndpointBlock);
      fs.writeFileSync(pythonPath, originalPython.replace(userEndpointBlock, ''));
      git(repos[1], ['add', 'app.py']);
      git(repos[1], ['commit', '-qm', 'delete python user provider']);
      await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(await linkedUserGets()).toBe(0);

      fs.writeFileSync(pythonPath, originalPython);
      git(repos[1], ['add', 'app.py']);
      git(repos[1], ['commit', '-qm', 'restore python user provider']);
      await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(await linkedUserGets()).toBe(linkedUserGetsBefore);

      const composerPath = path.join(repos[2], 'composer.json');
      const originalComposer = fs.readFileSync(composerPath, 'utf8');
      fs.writeFileSync(composerPath, originalComposer.replace('"name": "mai/php-api"', '"name": "python-api"'));
      git(repos[2], ['add', 'composer.json']);
      git(repos[2], ['commit', '-qm', 'introduce ambiguous provider alias']);
      const ambiguityUpdate = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(ambiguityUpdate).toMatch(/- linker: \d+ HTTP calls linked \(\d+ unresolved, [1-9]\d* ambiguous\)/);
      expect(await linkedUserGets()).toBe(0);

      fs.writeFileSync(composerPath, originalComposer);
      git(repos[2], ['add', 'composer.json']);
      git(repos[2], ['commit', '-qm', 'remove ambiguous provider alias']);
      await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(await linkedUserGets()).toBe(linkedUserGetsBefore);

      const pythonManifestPath = path.join(repos[1], 'pyproject.toml');
      const pythonManifest = fs.readFileSync(pythonManifestPath, 'utf8');
      const oldHostCallBefore = await admin.query<{ qualified_name: string; metadata: unknown }>(
        `SELECT qualified_name, metadata FROM graph_nodes
         WHERE project_id = $1 AND kind = 'http_call'
           AND metadata->>'source_service' = $2
           AND metadata->>'target_host' = 'python-public'
         ORDER BY qualified_name LIMIT 1`,
        [integrationProject, tsServiceId],
      );
      expect(oldHostCallBefore.rows).toHaveLength(1);
      fs.writeFileSync(pythonManifestPath, pythonManifest.replace('name = "python-public"', 'name = "python-renamed"'));
      git(repos[1], ['add', 'pyproject.toml']);
      git(repos[1], ['commit', '-qm', 'rename python service alias']);
      const pythonAliasUpdate = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(pythonAliasUpdate).toMatch(/- ts: .*full re-run — service identity manifest changed/);
      expect(pythonAliasUpdate).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);
      const hostOutcomes = await admin.query<{ target_host: string; edges: string }>(
        `SELECT caller.metadata->>'target_host' AS target_host, COUNT(edge.id)::text AS edges
         FROM graph_nodes caller
         LEFT JOIN graph_edges edge
           ON edge.project_id = caller.project_id
          AND edge.from_node = caller.id
          AND edge.relation = 'http_calls'
         WHERE caller.project_id = $1 AND caller.kind = 'http_call'
           AND caller.metadata->>'source_service' = $2
           AND caller.metadata->>'target_host' = ANY($3)
         GROUP BY caller.metadata->>'target_host' ORDER BY target_host`,
        [integrationProject, tsServiceId, ['python-public', 'python-renamed']],
      );
      expect(new Map(hostOutcomes.rows.map((row) => [row.target_host, Number(row.edges)]))).toEqual(
        new Map([['python-public', 0], ['python-renamed', 1]]),
      );
      const oldHostCallAfter = await admin.query<{ qualified_name: string; metadata: unknown }>(
        `SELECT qualified_name, metadata FROM graph_nodes
         WHERE project_id = $1 AND kind = 'http_call'
           AND metadata->>'source_service' = $2
           AND metadata->>'target_host' = 'python-public'
         ORDER BY qualified_name LIMIT 1`,
        [integrationProject, tsServiceId],
      );
      expect(oldHostCallAfter.rows).toEqual(oldHostCallBefore.rows);

      fs.writeFileSync(pythonManifestPath, pythonManifest);
      git(repos[1], ['add', 'pyproject.toml']);
      git(repos[1], ['commit', '-qm', 'restore python service alias']);
      const pythonAliasRestored = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(pythonAliasRestored).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);

      const pythonManifestAwayPath = path.join(repos[1], 'pyproject.saved');
      fs.renameSync(pythonManifestPath, pythonManifestAwayPath);
      git(repos[1], ['add', '-A']);
      git(repos[1], ['commit', '-qm', 'rename python identity manifest away']);
      const pythonManifestAway = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(pythonManifestAway).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);

      fs.renameSync(pythonManifestAwayPath, pythonManifestPath);
      git(repos[1], ['add', '-A']);
      git(repos[1], ['commit', '-qm', 'restore python identity manifest']);
      const pythonManifestRestored = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(pythonManifestRestored).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);

      const packagePath = path.join(repos[0], 'package.json');
      const sourceIdentityBefore = await admin.query<{ qualified_name: string }>(
        `SELECT qualified_name FROM graph_nodes
         WHERE project_id = $1 AND kind = 'file' AND qualified_name = $2`,
        [integrationProject, `service-source:${tsServiceId}:ts-client/src/client.ts`],
      );
      const originalPackage = fs.readFileSync(packagePath, 'utf8');
      const renamedPackage = originalPackage.replace('"name": "@mai/ts-client"', '"name": "@mai/ts-renamed"');
      fs.writeFileSync(packagePath, renamedPackage);
      git(repos[0], ['add', 'package.json']);
      git(repos[0], ['commit', '-qm', 'rename service alias']);
      const identityUpdate = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(identityUpdate).toMatch(/- ts: .*full re-run — service identity manifest changed/);
      expect(identityUpdate).toMatch(/- python: .*full re-run — service identity manifest changed/);
      const sourceIdentityAfter = await admin.query<{ qualified_name: string }>(
        `SELECT qualified_name FROM graph_nodes
         WHERE project_id = $1 AND kind = 'file' AND qualified_name = $2`,
        [integrationProject, `service-source:${tsServiceId}:ts-client/src/client.ts`],
      );
      expect(sourceIdentityAfter.rows).toEqual(sourceIdentityBefore.rows);

      await admin.query(
        `UPDATE projects SET metadata = jsonb_set(metadata, '{graph_excludes}', $2::jsonb)
         WHERE id = $1`,
        [integrationProject, JSON.stringify([packagePath])],
      );
      const excludedRenamedPackage = renamedPackage.replace('"name": "@mai/ts-renamed"', '"name": "@mai/ts-excluded-rename"');
      fs.writeFileSync(packagePath, excludedRenamedPackage);
      git(repos[0], ['add', 'package.json']);
      git(repos[0], ['commit', '-qm', 'rename excluded identity manifest']);
      const excludedIdentityUpdate = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(excludedIdentityUpdate).toMatch(/- ts: .*full re-run — service identity manifest changed/);

      const packageAwayPath = path.join(repos[0], 'package.saved');
      fs.renameSync(packagePath, packageAwayPath);
      git(repos[0], ['add', '-A']);
      git(repos[0], ['commit', '-qm', 'rename excluded identity manifest away']);
      const identityRenamedAway = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(identityRenamedAway).toMatch(/- ts: .*full re-run — service identity manifest changed/);
      expect(identityRenamedAway).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);

      fs.renameSync(packageAwayPath, packagePath);
      git(repos[0], ['add', '-A']);
      git(repos[0], ['commit', '-qm', 'restore excluded identity manifest']);
      const identityRestored = await runGraphUpdate({ projectId: integrationProject, slug: slugs[2] });
      expect(identityRestored).toMatch(/- ts: .*full re-run — service identity manifest changed/);
      expect(identityRestored).toMatch(/- python: .*full re-run — service identity manifest changed/);
      expect(await persistedEdgeCount(shellEdges[0])).toBe(1);

      const snapshot = async (): Promise<{ nodes: string[]; edges: string[] }> => {
        const nodes = await admin.query<{ value: string }>(
          `SELECT kind || ':' || qualified_name AS value FROM graph_nodes
           WHERE project_id = $1 ORDER BY value`, [integrationProject],
        );
        const edgeRows = await admin.query<{ value: string }>(
          `SELECT source.kind || ':' || source.qualified_name || '—' || edge.relation || '→'
                  || target.kind || ':' || target.qualified_name AS value
           FROM graph_edges edge
           JOIN graph_nodes source ON source.id = edge.from_node
           JOIN graph_nodes target ON target.id = edge.to_node
           WHERE edge.project_id = $1 ORDER BY value`, [integrationProject],
        );
        return { nodes: nodes.rows.map((row) => row.value), edges: edgeRows.rows.map((row) => row.value) };
      };
      const incremental = await snapshot();
      const validMetadata = await admin.query<{ metadata: unknown }>(
        `SELECT metadata FROM projects WHERE id = $1`, [integrationProject],
      );
      expect(validMetadata.rows).toHaveLength(1);
      await admin.query(
        `UPDATE projects SET metadata = jsonb_set(metadata, '{repos}', '["relative-root"]'::jsonb)
         WHERE id = $1`,
        [integrationProject],
      );
      await expect(runGraphUpdate({ projectId: integrationProject, slug: slugs[2] }))
        .rejects.toThrow(/--replace-repos --repo <absolute-repo>/);
      expect(await snapshot()).toEqual(incremental);
      await expect(runGraphBuild({ projectId: integrationProject, slug: slugs[2] }))
        .rejects.toThrow(/--replace-repos --repo <absolute-repo>/);
      expect(await snapshot()).toEqual(incremental);
      await admin.query(
        `UPDATE projects SET metadata = $2::jsonb WHERE id = $1`,
        [integrationProject, JSON.stringify(validMetadata.rows[0].metadata)],
      );
      await runGraphBuild({ projectId: integrationProject, slug: slugs[2] });
      expect(await snapshot()).toEqual(incremental);
    } finally {
      if (integrationProject) await admin.query(`DELETE FROM projects WHERE id = $1`, [integrationProject]);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.sequential('physical multi-repo orchestration', () => {
  it('keeps identical basename and relative-path owners distinct across services', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-cross-service-same-')));
    const repoA = path.join(temp, 'a', 'shared');
    const repoB = path.join(temp, 'b', 'shared');
    let projectId = '';
    const git = (repo: string, args: string[]): void => {
      const result = spawnSync('git', [
        '-C', repo, '-c', 'user.email=same-service@test.invalid',
        '-c', 'user.name=SameService', ...args,
      ], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    };
    const makeRepo = (repo: string, ownAlias: string, targetAlias: string): void => {
      const sourceDir = path.join(repo, 'src');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: ownAlias }, null, 2)}\n`);
      fs.writeFileSync(path.join(repo, 'pyproject.toml'), `[project]\nname = "${ownAlias}"\n`);
      fs.writeFileSync(path.join(repo, 'composer.json'), `${JSON.stringify({ name: `mai/${ownAlias}` }, null, 2)}\n`);
      fs.writeFileSync(path.join(sourceDir, 'service.ts'), `
import { Kafka } from 'kafkajs';
interface RouterLike { get(route: string, handler: () => void): void; }
const app: RouterLike = { get: (_route, _handler): void => undefined };
app.get('/health', () => undefined);
void fetch('https://${targetAlias}/health');
const kafka = new Kafka({ clientId: 'same', brokers: ['localhost:9092'] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'same' });
void producer.send({ topic: 'orders.created', messages: [] });
void consumer.subscribe({ topic: 'orders.created' });
`);
      fs.writeFileSync(path.join(sourceDir, 'service.py'), `
from fastapi import FastAPI
import requests
app = FastAPI()
@app.get("/health")
def get_user():
    requests.get("https://${targetAlias}/health")
`);
      fs.writeFileSync(path.join(sourceDir, 'service.php'), `<?php
register_rest_route('acme/v1', '/health', array('methods' => 'GET'));
wp_remote_get('https://${targetAlias}/health');
function same_handler(): void {}
`);
      git(repo, ['init', '-q']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'fixture']);
    };
    try {
      makeRepo(repoA, 'same-a', 'same-b');
      makeRepo(repoB, 'same-b', 'same-a');
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata)
         VALUES ($1, $1, $2, jsonb_build_object('repos', jsonb_build_array($3::text, $4::text)))
         RETURNING id`,
        [slugs[3], temp, repoA, repoB],
      );
      projectId = inserted.rows[0].id;
      const { runGraphBuild } = await import('../graph/build.js');
      const { runGraphUpdate } = await import('../graph/update.js');
      await runGraphBuild({ projectId, slug: slugs[3] });

      const ownedSources = await admin.query<{ kind: string; qualified_name: string; file_path: string }>(
        `SELECT kind, qualified_name, file_path FROM graph_nodes
         WHERE project_id = $1 AND file_path = ANY($2) AND kind = ANY($3)
         ORDER BY kind, qualified_name`,
        [
          projectId,
          [
            path.join(repoA, 'src', 'service.ts'), path.join(repoA, 'src', 'service.py'),
            path.join(repoA, 'src', 'service.php'), path.join(repoB, 'src', 'service.ts'),
            path.join(repoB, 'src', 'service.py'), path.join(repoB, 'src', 'service.php'),
          ],
          ['file', 'function', 'class', 'http_call'],
        ],
      );
      const files = ownedSources.rows.filter((row) => row.kind === 'file');
      expect(files).toHaveLength(6);
      expect(new Set(files.map((row) => row.qualified_name)).size).toBe(6);
      expect(files.every((row) => row.qualified_name.startsWith('service-source:'))).toBe(true);
      const calls = ownedSources.rows.filter((row) => row.kind === 'http_call');
      expect(calls.length).toBeGreaterThanOrEqual(6);
      expect(new Set(calls.map((row) => row.qualified_name)).size).toBe(calls.length);

      const serviceRows = await admin.query<{ service_id: string }>(
        `SELECT DISTINCT metadata->>'service_id' AS service_id FROM graph_nodes
         WHERE project_id = $1 AND kind = 'endpoint' ORDER BY service_id`,
        [projectId],
      );
      expect(serviceRows.rows).toHaveLength(2);
      const relationRows = await admin.query<{ relation: string; count: string }>(
        `SELECT relation, COUNT(*)::text AS count FROM graph_edges
         WHERE project_id = $1 AND relation = ANY($2)
         GROUP BY relation ORDER BY relation`,
        [projectId, ['emits', 'http_calls', 'listens_on', 'serves_route']],
      );
      const relationMap = new Map(relationRows.rows.map((row) => [row.relation, Number(row.count)]));
      expect(relationMap.get('emits')).toBe(2);
      expect(relationMap.get('listens_on')).toBe(2);
      expect(relationMap.get('serves_route')).toBeGreaterThanOrEqual(6);
      expect(relationMap.get('http_calls')).toBeGreaterThanOrEqual(6);

      const sourceServices = await admin.query<{ source_service: string; target_host: string }>(
        `SELECT DISTINCT metadata->>'source_service' AS source_service,
                         metadata->>'target_host' AS target_host
         FROM graph_nodes
         WHERE project_id = $1 AND kind = 'http_call'
           AND metadata->>'target_host' = ANY($2)
         ORDER BY target_host`,
        [projectId, ['same-a', 'same-b']],
      );
      const serviceByTarget = new Map(sourceServices.rows.map((row) => [row.target_host, row.source_service]));
      const serviceA = serviceByTarget.get('same-b');
      const serviceB = serviceByTarget.get('same-a');
      if (serviceA === undefined || serviceB === undefined) throw new Error('same-basename service identities missing');
      const fileNodeCount = async (file: string): Promise<number> => {
        const result = await admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM graph_nodes
           WHERE project_id = $1 AND kind = 'file' AND file_path = $2`,
          [projectId, file],
        );
        return Number(result.rows[0].count);
      };
      const endpointCount = async (serviceId: string, route: string): Promise<number> => {
        const result = await admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM graph_nodes
           WHERE project_id = $1 AND kind = 'endpoint'
             AND metadata->>'service_id' = $2 AND metadata->>'path' = $3`,
          [projectId, serviceId, route],
        );
        return Number(result.rows[0].count);
      };
      const eventCount = async (): Promise<number> => {
        const result = await admin.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM graph_nodes
           WHERE project_id = $1 AND kind = 'event_channel'
             AND qualified_name = 'event:kafka:orders.created'`,
          [projectId],
        );
        return Number(result.rows[0].count);
      };

      const repoABefore = ownedSources.rows
        .filter((row) => row.file_path.startsWith(repoA + path.sep))
        .map((row) => `${row.kind}:${row.qualified_name}`)
        .sort();
      fs.appendFileSync(path.join(repoB, 'src', 'service.ts'), '\n// repo-b-only change\n');
      git(repoB, ['add', 'src/service.ts']);
      git(repoB, ['commit', '-qm', 'change repo b only']);
      await runGraphUpdate({ projectId, slug: slugs[3] });
      const repoAAfter = await admin.query<{ value: string }>(
        `SELECT kind || ':' || qualified_name AS value FROM graph_nodes
         WHERE project_id = $1 AND starts_with(file_path, $2 || '/')
         ORDER BY value`,
        [projectId, repoA],
      );
      expect(repoAAfter.rows.map((row) => row.value)).toEqual(repoABefore);

      for (const relative of ['src/service.ts', 'src/service.py', 'src/service.php']) {
        const fileA = path.join(repoA, relative);
        const fileB = path.join(repoB, relative);
        const textA = fs.readFileSync(fileA, 'utf8');
        const textB = fs.readFileSync(fileB, 'utf8');
        fs.rmSync(fileB);
        git(repoB, ['add', '-A']);
        git(repoB, ['commit', '-qm', `delete repo b ${path.basename(relative)}`]);
        await runGraphUpdate({ projectId, slug: slugs[3] });
        expect(await fileNodeCount(fileA)).toBe(1);
        expect(await fileNodeCount(fileB)).toBe(0);
        if (relative.endsWith('.ts') || relative.endsWith('.py')) {
          expect(await endpointCount(serviceB, '/health')).toBe(1);
        } else {
          expect(await endpointCount(serviceB, '/acme/v1/health')).toBe(0);
          expect(await endpointCount(serviceA, '/acme/v1/health')).toBe(1);
        }
        if (relative.endsWith('.ts')) expect(await eventCount()).toBe(1);

        fs.writeFileSync(fileB, textB);
        git(repoB, ['add', relative]);
        git(repoB, ['commit', '-qm', `restore repo b ${path.basename(relative)}`]);
        await runGraphUpdate({ projectId, slug: slugs[3] });
        fs.rmSync(fileA);
        git(repoA, ['add', '-A']);
        git(repoA, ['commit', '-qm', `delete repo a ${path.basename(relative)}`]);
        await runGraphUpdate({ projectId, slug: slugs[3] });
        expect(await fileNodeCount(fileA)).toBe(0);
        expect(await fileNodeCount(fileB)).toBe(1);
        if (relative.endsWith('.ts') || relative.endsWith('.py')) {
          expect(await endpointCount(serviceA, '/health')).toBe(1);
        } else {
          expect(await endpointCount(serviceA, '/acme/v1/health')).toBe(0);
          expect(await endpointCount(serviceB, '/acme/v1/health')).toBe(1);
        }
        if (relative.endsWith('.ts')) expect(await eventCount()).toBe(1);

        fs.writeFileSync(fileA, textA);
        git(repoA, ['add', relative]);
        git(repoA, ['commit', '-qm', `restore repo a ${path.basename(relative)}`]);
        await runGraphUpdate({ projectId, slug: slugs[3] });
      }

      const tsA = path.join(repoA, 'src', 'service.ts');
      const tsB = path.join(repoB, 'src', 'service.ts');
      const tsAText = fs.readFileSync(tsA, 'utf8');
      const tsBText = fs.readFileSync(tsB, 'utf8');
      fs.rmSync(tsA);
      git(repoA, ['add', '-A']);
      git(repoA, ['commit', '-qm', 'delete first event owner']);
      await runGraphUpdate({ projectId, slug: slugs[3] });
      expect(await eventCount()).toBe(1);
      fs.rmSync(tsB);
      git(repoB, ['add', '-A']);
      git(repoB, ['commit', '-qm', 'delete final event owner']);
      await runGraphUpdate({ projectId, slug: slugs[3] });
      expect(await eventCount()).toBe(0);
      fs.writeFileSync(tsA, tsAText);
      git(repoA, ['add', 'src/service.ts']);
      git(repoA, ['commit', '-qm', 'restore first event owner']);
      fs.writeFileSync(tsB, tsBText);
      git(repoB, ['add', 'src/service.ts']);
      git(repoB, ['commit', '-qm', 'restore second event owner']);
      await runGraphUpdate({ projectId, slug: slugs[3] });
      expect(await eventCount()).toBe(1);
    } finally {
      if (projectId) await admin.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);

  it('uses longest-prefix child ownership independent of registered-root order', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-cross-service-nested-')));
    const parent = path.join(temp, 'worktree');
    const child = path.join(parent, 'packages', 'child');
    let projectId = '';
    const git = (args: string[]): void => {
      const result = spawnSync('git', [
        '-C', parent, '-c', 'user.email=nested-service@test.invalid',
        '-c', 'user.name=NestedService', ...args,
      ], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    };
    const snapshot = async (): Promise<string[]> => {
      const result = await admin.query<{ value: string }>(
        `SELECT kind || ':' || qualified_name AS value FROM graph_nodes
         WHERE project_id = $1 ORDER BY value`, [projectId],
      );
      return result.rows.map((row) => row.value);
    };
    try {
      fs.mkdirSync(path.join(parent, 'src'), { recursive: true });
      fs.mkdirSync(path.join(child, 'src'), { recursive: true });
      fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"parent-service"}\n');
      fs.writeFileSync(path.join(parent, 'src', 'parent.ts'), 'export function parentOnly(): number { return 1; }\n');
      fs.writeFileSync(path.join(child, 'package.json'), '{"name":"child-service"}\n');
      fs.writeFileSync(path.join(child, 'src', 'child.ts'), 'export function childOnly(): number { return 2; }\n');
      git(['init', '-q']);
      git(['add', '.']);
      git(['commit', '-qm', 'fixture']);
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata)
         VALUES ($1, $1, $2, jsonb_build_object('repos', jsonb_build_array($3::text, $4::text)))
         RETURNING id`,
        [slugs[4], temp, parent, child],
      );
      projectId = inserted.rows[0].id;
      const { runGraphBuild } = await import('../graph/build.js');
      const { runGraphUpdate } = await import('../graph/update.js');
      await runGraphBuild({ projectId, slug: slugs[4] });
      const parentFirst = await snapshot();
      const childRows = await admin.query<{ qualified_name: string }>(
        `SELECT qualified_name FROM graph_nodes
         WHERE project_id = $1 AND file_path = $2 AND kind = 'file'`,
        [projectId, path.join(child, 'src', 'child.ts')],
      );
      expect(childRows.rows).toHaveLength(1);
      expect(childRows.rows[0].qualified_name).toContain(':child/src/child.ts');
      expect(childRows.rows[0].qualified_name).not.toContain('worktree/packages/child');

      await admin.query(
        `UPDATE projects SET metadata = jsonb_set(metadata, '{repos}', jsonb_build_array($2::text, $3::text))
         WHERE id = $1`,
        [projectId, child, parent],
      );
      await runGraphBuild({ projectId, slug: slugs[4] });
      expect(await snapshot()).toEqual(parentFirst);

      fs.appendFileSync(path.join(child, 'src', 'child.ts'), '\nexport const changedInChild = true;\n');
      git(['add', 'packages/child/src/child.ts']);
      git(['commit', '-qm', 'change child only']);
      const update = await runGraphUpdate({ projectId, slug: slugs[4] });
      expect(update).toContain('- child: diff (1 changed, 0 deleted)');
      const childFileRows = await admin.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM graph_nodes
         WHERE project_id = $1 AND kind = 'file' AND file_path = $2`,
        [projectId, path.join(child, 'src', 'child.ts')],
      );
      expect(childFileRows.rows[0].count).toBe('1');
    } finally {
      if (projectId) await admin.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
