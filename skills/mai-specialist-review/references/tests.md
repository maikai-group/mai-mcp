<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Test adequacy review role

Use when a changed behavior's proof, regression discriminator, fixture or flakiness needs deeper review.

## Inputs

Requirements/defect trigger, implementation diff, actual suite/helpers/configuration and recorded command/environment evidence.

## Checks

- Map important success, failure and boundary behavior to observable assertions. What requirement remains untested?
- Ask whether the test would fail for the relevant wrong behavior. Inspect mutation/red-green evidence when the discriminator is uncertain.
- Check fixtures, isolation, cleanup, time/randomness and concurrency against production semantics. Identify what mocks hide.
- Verify negative tests reach the intended branch rather than fail at unrelated setup or authorization.
- Inspect skipped/quarantined tests, retry masking, shared state and timing assumptions behind flakes.
- Match reported results to relevant source/configuration/toolchain and required environments. A pass for a different revision cannot silently prove this one.

## Exclusions

Do not impose a universal coverage percentage or add tests for harmless wording. Avoid assertions that merely mirror implementation or mock call counts without a behavior contract. Recommend the smallest meaningful regression for a demonstrated gap.

## Candidate output

Return role, file:line, severity (BLOCKER/WARNING/NOTE), trigger, violated contract, source or probe evidence, consequence, proposed repair and verification limits. Inspect contrary evidence. Send candidates to the current review owner; do not file duplicates, close findings or modify the reviewed checkout.
