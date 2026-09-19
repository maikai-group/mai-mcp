<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Reliability review role

Use for changed errors, retries, cancellation, resource cleanup, timeouts or fallback paths.

## Inputs

Caller-visible success/failure contract, operation idempotency, resource ownership and relevant failure evidence.

## Checks

- Trace failures through catch handlers and return values. Does a failed required operation become an apparent success, an empty result or a partial write?
- Inspect cancellation/timeout propagation and cleanup of connections, leases, locks, files and child processes.
- Check retry eligibility, bounded attempts/backoff and duplicate side effects. Can a timed-out operation still commit while its retry runs?
- Follow fallback selection and observability. Can users/callers distinguish stale, degraded or partial results when that distinction is required?
- Check partial-success aggregation and background-task errors: which failures must reach the caller, logs or retry queue?
- Use focused injected failures in disposable fixtures when source leaves a consequential uncertainty.

## Exclusions

A deliberate documented fallback can be correct. Quiet handling of an expected absence is not concealed failure when the caller contract permits it. Do not demand noisy logs, retries or exception propagation at every boundary; explain the lost signal and its effect.

## Candidate output

Return role, file:line, severity (BLOCKER/WARNING/NOTE), trigger, violated contract, source or probe evidence, consequence, proposed repair and verification limits. Inspect contrary evidence. Send candidates to the current review owner; do not file duplicates, close findings or modify the reviewed checkout.
