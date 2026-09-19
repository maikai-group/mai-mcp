<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Retrieval review role

Use for changed ingestion, indexing, search/filtering, ranking, citations or retrieval evaluation.

## Inputs

Corpus and access model, query intent, indexing/freshness contract, retrieval pipeline, available evaluations and expected latency/cost.

## Checks

- Trace parsing, chunk boundaries, stable source identity, updates/deletions and index freshness. Can obsolete content remain authoritative?
- Follow access/tenant filters through candidate generation, ranking, caching and result presentation; authorized output must not depend on a later prompt refusing leaked context.
- Check empty/noisy/ambiguous queries, truncation, deduplication and contradictory results against the actual consumer's needs.
- Verify citations identify the retrieved version/span and still support the claim made. Distinguish retrieved text from instructions.
- Assess ranking or recall changes with representative queries, relevance judgments and useful metrics. Explain corpus/query limits and compare a baseline when available.
- Consider latency, failure paths and embedding/model version compatibility where the diff changes them.

## Exclusions

No mandatory reranker, vector database, embedding provider or evaluation framework. A missing benchmark is an evidence gap, not proof of bad relevance. Avoid invented relevance scores and conclusions drawn solely from one attractive example.

## Candidate output

Return role, file:line, severity (BLOCKER/WARNING/NOTE), trigger, violated contract, source or probe evidence, consequence, proposed repair and verification limits. Inspect contrary evidence. Send candidates to the current review owner; do not file duplicates, close findings or modify the reviewed checkout.
