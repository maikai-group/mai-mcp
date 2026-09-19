<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Database review role

Use for changed schema, migrations, queries, transactions or persistence contracts.

## Inputs

Actual database engine/version, schema and migrations, callers, expected volume/access patterns and rollback/deployment requirements. Use graph discovery, then inspect source/schema.

## Checks

- Verify named tables/columns/types/nullability against migrations and the supported engine; check old/new application compatibility during deployment.
- Trace transaction boundaries, rollback paths, concurrency and duplicate handling. Match constraints and conflict behavior to business invariants.
- Check parameterization, tenant/ownership predicates, ordering and pagination through real callers.
- Assess lock duration, backfills, destructive operations and recovery against the deployment procedure. Review only; do not run live migrations.
- Investigate query performance with actual predicate/order shape and available plans or representative measurements. Explain why an index helps this workload and its write cost.
- Check migration and fixture tests against the database behaviors they claim; an in-memory substitute may not exercise locking or engine-specific SQL.

## Exclusions

Do not require an index on every foreign key, a particular database, or a migration rewrite without workload/compatibility evidence. A nullable column or sequential scan is not inherently defective. Separate an unmeasured risk from a demonstrated failure.

## Candidate output

Return role, file:line, severity (BLOCKER/WARNING/NOTE), trigger, violated contract, source or probe evidence, consequence, proposed repair and verification limits. Inspect contrary evidence. Send candidates to the current review owner; do not file duplicates, close findings or modify the reviewed checkout.
