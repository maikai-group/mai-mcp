-- E2E fixture project for the dashboard smoke suite. Idempotent: fully replaces
-- the 'e2e-dash' project so the approve flow mutates fixture data only, never a
-- real project. Timestamps are relative to now (recency-window safe).
\set ON_ERROR_STOP on

DELETE FROM projects WHERE slug = 'e2e-dash';
INSERT INTO projects (slug, name, path, metadata)
VALUES ('e2e-dash', 'E2E Dashboard', '/tmp',
        jsonb_build_object('repos', jsonb_build_array('/tmp')));

-- Review queue candidates (agent-inferred → surface in the review queue).
INSERT INTO code_decisions (project_id, decision_type, description, reasoning, confidence, source, keywords, timestamp)
SELECT (SELECT id FROM projects WHERE slug = 'e2e-dash'), 'arch', d.descr, 'seeded for e2e', 0.5,
       'agent-inferred', ARRAY['e2e'], NOW() - make_interval(mins => d.n)
FROM (VALUES ('E2E review candidate alpha', 1),
             ('E2E review candidate beta', 2),
             ('E2E review candidate gamma', 3)) AS d(descr, n);

-- A session for the activity feed / sessions view.
INSERT INTO code_sessions (project_id, original_session_id, started_at, summary)
VALUES ((SELECT id FROM projects WHERE slug = 'e2e-dash'), 'e2e-session-1', NOW() - INTERVAL '5 minutes', 'E2E seeded session');

-- Graph: 5 nodes in e2e-repoA/src, 2 in e2e-repoB/lib, 1 db-schema table.
INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line, extracted_by)
SELECT (SELECT id FROM projects WHERE slug = 'e2e-dash'), n.kind, n.name, n.qname, n.fp, n.ln, 'seed'
FROM (VALUES
  ('function', 'fa', 'repoA/src/a.ts#fa', '/tmp/e2e-repoA/src/a.ts', 1),
  ('function', 'fb', 'repoA/src/a.ts#fb', '/tmp/e2e-repoA/src/a.ts', 5),
  ('function', 'fc', 'repoA/src/b.ts#fc', '/tmp/e2e-repoA/src/b.ts', 2),
  ('function', 'fd', 'repoA/src/b.ts#fd', '/tmp/e2e-repoA/src/b.ts', 8),
  ('file',     'c.ts', 'repoA/src/c.ts',  '/tmp/e2e-repoA/src/c.ts', NULL),
  ('function', 'gu', 'repoB/lib/u.ts#gu', '/tmp/e2e-repoB/lib/u.ts', 3),
  ('function', 'gv', 'repoB/lib/u.ts#gv', '/tmp/e2e-repoB/lib/u.ts', 9),
  ('table',    'things', 'public.things', NULL, NULL)
) AS n(kind, name, qname, fp, ln);

-- Edges (joined by qualified_name).
INSERT INTO graph_edges (project_id, from_node, to_node, relation)
SELECT p.id, f.id, t.id, e.rel
FROM projects p
JOIN (VALUES
  ('repoA/src/a.ts#fa', 'repoA/src/a.ts#fb', 'calls'),
  ('repoA/src/a.ts#fa', 'repoA/src/b.ts#fc', 'calls'),
  ('repoA/src/b.ts#fc', 'repoA/src/b.ts#fd', 'calls'),
  ('repoA/src/a.ts#fb', 'repoB/lib/u.ts#gu', 'calls'),
  ('repoA/src/a.ts#fa', 'public.things', 'reads_table')
) AS e(fromq, toq, rel) ON true
JOIN graph_nodes f ON f.project_id = p.id AND f.qualified_name = e.fromq
JOIN graph_nodes t ON t.project_id = p.id AND t.qualified_name = e.toq
WHERE p.slug = 'e2e-dash';

-- Roadmap board fixtures (plan 11). Ideas cascade with the e2e-dash project.
INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
SELECT (SELECT id FROM projects WHERE slug = 'e2e-dash'), i.t, i.s, i.p, i.o, 'user'
FROM (VALUES ('E2E parked idea', 'idea', 'someday', 1000),
             ('E2E planned item', 'planned', 'now', 1000),
             ('E2E building item', 'building', 'now', 1000)) AS i(t, s, p, o);

-- Plan 42 ordering fixtures: two selected-project cards per priority share one
-- column, with ranks deliberately interleaved across priority bands. Priority,
-- not the raw rank, must control the rendered band order.
INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
SELECT (SELECT id FROM projects WHERE slug = 'e2e-dash'), i.t, 'idea', i.p, i.o, 'user'
FROM (VALUES
  ('E2E P42 project now alpha',    'now',      9000),
  ('E2E P42 project now beta',     'now',      1000),
  ('E2E P42 project next alpha',   'next',    -4000),
  ('E2E P42 project next beta',    'next',     4000),
  ('E2E P42 project later alpha',  'later',    7000),
  ('E2E P42 project later beta',   'later',   -7000),
  ('E2E P42 project someday alpha','someday',  3000),
  ('E2E P42 project someday beta', 'someday', -3000)
) AS i(t, p, o);

-- Global ideas do not cascade with the fixture project. Delete only Plan 42's
-- exact user-owned title prefix so repeated setup cannot touch operator data.
DELETE FROM ideas
WHERE project_id IS NULL
  AND source = 'user'
  AND title LIKE 'E2E P42 %';
INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
VALUES (NULL, 'E2E P42 global now overlap', 'idea', 'now', -9999, 'user');

-- Keep one column realistically tall. This catches collision strategies that
-- incorrectly prefer the active card itself over a cross-column destination.
INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
SELECT (SELECT id FROM projects WHERE slug = 'e2e-dash'),
       'E2E parked filler ' || n, 'idea', 'someday', (n + 1) * 1000, 'user'
FROM generate_series(1, 20) AS n;

-- Plan 43 operator inbox fixtures. Fixed ids let the browser proof mutate and
-- restore only its own rows while the global fixture remains deterministic.
INSERT INTO plans (id, project_id, slug, path, title, current_sha, status, updated_at)
SELECT '43000000-0000-4000-8000-000000000001', p.id, 'e2e-operator-plan',
       'docs/e2e-operator-plan.md', 'E2E Operator Plan', repeat('0', 64), 'executing', NOW()
FROM projects p WHERE p.slug = 'e2e-dash';

INSERT INTO operator_tasks
  (id, project_id, plan_id, task_key, content_hash, source_kind, source_plan_slug,
   kind, title, instructions, assigned_by_agent, assigned_by_session, sort_order,
   status, resolution_note, resolved_at, removed_at, created_at, updated_at)
SELECT v.id::uuid, p.id,
       CASE WHEN v.source_kind = 'plan' THEN '43000000-0000-4000-8000-000000000001'::uuid ELSE NULL END,
       v.task_key, v.content_hash, v.source_kind,
       CASE WHEN v.source_kind = 'plan' THEN 'e2e-operator-plan' ELSE NULL END,
       v.kind, v.title, v.instructions, v.agent, 'e2e-operator-session', v.sort_order,
       v.status, v.reason,
       CASE WHEN v.status IN ('completed', 'dismissed') THEN NOW() - INTERVAL '1 hour' ELSE NULL END,
       CASE WHEN v.removed THEN NOW() - INTERVAL '30 minutes' ELSE NULL END,
       NOW() - make_interval(mins => v.age_minutes), NOW() - make_interval(mins => v.age_minutes)
FROM projects p
CROSS JOIN (VALUES
  ('43000000-0000-4000-8000-000000000011', 'O1', repeat('1', 64), 'plan', 'blocking',
   'E2E blocking task', 'Complete the E2E blocking work.', 'plan-agent', 0, 'pending', NULL::text, false, 7),
  ('43000000-0000-4000-8000-000000000012', 'O2', repeat('2', 64), 'plan', 'follow_up',
   'E2E follow-up task', 'Complete the E2E follow-up work.', 'plan-agent', 1, 'pending', NULL::text, false, 6),
  ('43000000-0000-4000-8000-000000000013', 'O3', repeat('3', 64), 'plan', 'blocking',
   'E2E completed task', 'Previously completed E2E work.', 'plan-agent', 2, 'completed', NULL::text, false, 5),
  ('43000000-0000-4000-8000-000000000014', 'E2E_ADHOC', repeat('4', 64), 'ad_hoc', 'follow_up',
   'E2E agent assignment', 'Handle the unlinked E2E assignment.', 'ad-hoc-agent', 0, 'pending', NULL::text, false, 4),
  ('43000000-0000-4000-8000-000000000015', 'O4', repeat('5', 64), 'plan', 'follow_up',
   'E2E dismissed task', 'Dismissed E2E work.', 'plan-agent', 3, 'dismissed', 'waived for E2E proof', false, 3),
  ('43000000-0000-4000-8000-000000000016', 'O5', repeat('6', 64), 'plan', 'blocking',
   'E2E removed task', 'Removed E2E history.', 'plan-agent', 4, 'completed', NULL::text, true, 2),
  ('43000000-0000-4000-8000-000000000017', 'E2E_ADHOC_2', repeat('7', 64), 'ad_hoc', 'blocking',
   'E2E second agent assignment', 'Handle the second unlinked assignment.', 'other-ad-hoc-agent', 1, 'pending', NULL::text, false, 1)
) AS v(id, task_key, content_hash, source_kind, kind, title, instructions, agent,
       sort_order, status, reason, removed, age_minutes)
WHERE p.slug = 'e2e-dash';

-- user_facts is GLOBAL (no project_id) — seed and clean by the evidence marker.
DELETE FROM user_facts WHERE evidence = 'e2e-seed';
INSERT INTO user_facts (category, fact, evidence, source)
VALUES ('preference', 'E2E seeded fact', 'e2e-seed', 'user-approved'),
       ('workflow', 'E2E fact candidate', 'e2e-seed', 'agent-inferred');

-- Plan 29 heart fixture: two high-degree hubs and enough leaves to exceed the
-- overview's TOP_N_PER_MODULE=8 landing cap deterministically.
INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line, extracted_by)
SELECT p.id, 'function', v.name, 'repoA/src/hearts.ts#' || v.name,
       '/tmp/e2e-repoA/src/hearts.ts', v.line, 'seed'
FROM projects p
CROSS JOIN LATERAL (
  SELECT 'hub_a'::text AS name, 100 AS line
  UNION ALL SELECT 'hub_b', 200
  UNION ALL SELECT 'hub_a_leaf_' || n, 100 + n FROM generate_series(1, 10) n
  UNION ALL SELECT 'hub_b_leaf_' || n, 200 + n FROM generate_series(1, 9) n
) v
WHERE p.slug = 'e2e-dash';

INSERT INTO graph_edges (project_id, from_node, to_node, relation)
SELECT p.id, hub.id, leaf.id, 'calls'
FROM projects p
CROSS JOIN (VALUES ('hub_a', 10), ('hub_b', 9)) AS side(hub, leaves)
JOIN graph_nodes hub ON hub.project_id = p.id
  AND hub.qualified_name = 'repoA/src/hearts.ts#' || side.hub
JOIN LATERAL generate_series(1, side.leaves) AS leaf_no(n) ON true
JOIN graph_nodes leaf ON leaf.project_id = p.id
  AND leaf.qualified_name = 'repoA/src/hearts.ts#' || side.hub || '_leaf_' || n
WHERE p.slug = 'e2e-dash';

-- Plan 29 execution-time addition (operator-approved 2026-08-21): git evidence
-- and decision links, so the 7-day pulse and the `time`/`confidence` Z modes are
-- exercisable in a real browser. Without these every node has lastTouched NULL
-- and no linked confidence, so two of three Z modes grey out and the pulse
-- never starts. This also exercises Task 4's repo-scoped lastTouched join.
INSERT INTO code_commits (project_id, commit_hash, message, timestamp, committed_at, repo_path)
SELECT p.id, v.sha, v.msg, v.ts::timestamptz, v.ts::timestamptz, '/tmp'
FROM projects p
CROSS JOIN (VALUES
  (repeat('a', 40), 'seed: recent hearts touch', (NOW() - INTERVAL '2 days')::text),
  (repeat('b', 40), 'seed: older module touch',  (NOW() - INTERVAL '40 days')::text)
) AS v(sha, msg, ts)
WHERE p.slug = 'e2e-dash';

-- hearts.ts is inside the 7-day window (pulses); a.ts is deliberately outside it,
-- so the pulse set is a strict subset and an always-on ring would be visible.
INSERT INTO commit_files (project_id, commit_id, path, status)
SELECT p.id, c.id, v.path, 'modified'
FROM projects p
JOIN code_commits c ON c.project_id = p.id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN c.commit_hash = repeat('a', 40)
    THEN 'e2e-repoA/src/hearts.ts' ELSE 'e2e-repoA/src/a.ts' END)
) AS v(path)
WHERE p.slug = 'e2e-dash';

-- One still-valid decision linked to hub_a gives the `confidence` Z mode a
-- non-null input; every other node stays on the neutral plane.
INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
SELECT p.id, 'decision', d.id, 'graph_node', n.id, 'affects'
FROM projects p
JOIN code_decisions d ON d.project_id = p.id
JOIN graph_nodes n ON n.project_id = p.id
 AND n.qualified_name = 'repoA/src/hearts.ts#hub_a'
WHERE p.slug = 'e2e-dash'
LIMIT 1;
