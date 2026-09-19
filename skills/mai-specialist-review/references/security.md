<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Security review role

Use for changed trust boundaries, authentication/authorization, secrets, untrusted input or sensitive output.

## Inputs

Bounded diff/pins, entrypoints and callers, actor/tenant model, relevant data sensitivity and existing security requirements. Verify these in source; do not assume a web stack.

## Checks

- Trace attacker-controlled input to database, shell, template, filesystem, network and deserialization sinks. Verify actual escaping, parameterization, normalization and allowlists at the boundary.
- Distinguish login from authorization. Check resource ownership/tenant predicates, privileged operations, alternate routes and background consumers.
- Follow credentials and sensitive data through logs, errors, files, URLs and returned payloads. Check lifetimes and redaction where the changed path exposes them.
- Assess path traversal, redirect/SSRF, upload handling and symlink boundaries only where the feature creates those surfaces.
- Check fail-open behavior and time-of-check/use races at affected authorization or filesystem boundaries. Identify what an actor can actually control.
- Reuse existing negative tests or a safe local fixture. Never demonstrate a finding by attacking a real third-party or deploying an exploit.

## Exclusions

A missing framework feature is not automatically a vulnerability. Establish reachability, actor capability and the failed security property. Do not report secrets by copying their values; use redacted locations. A broader hardening preference without a violated requirement is nonblocking.

## Candidate output

Return role, file:line, severity (BLOCKER/WARNING/NOTE), trigger, violated contract, source or probe evidence, consequence, proposed repair and verification limits. Inspect contrary evidence. Send candidates to the current review owner; do not file duplicates, close findings or modify the reviewed checkout.
