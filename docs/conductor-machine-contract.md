# conductor-machine-contract/2

The pinnable machine contract between mai-mcp and external machine consumers —
first the M-AI5 conductor, second the M-AI5 Plan-2 status panel. It supersedes
`conductor-machine-contract/1`, an unshipped draft whose consumer-owned `kind`
enum and cross-repo ID-derivation scheme never reached production.

**Pinning rule:** a consumer locks `{contract, buildSha}` where `contract` is
the literal `conductor-machine-contract/2` and `buildSha` is `build.sha` from a
`read-call ping` against the deployed generation. Both are asserted at consumer
preflight; a mismatch is a configuration stop, never a silent downgrade.

## Write tools

Reached through the stdio MCP server (or `scripts/mai-review-bridge.mjs` for
harnesses that cancel registered MCP calls). Both are validated inserts in the
ungated tracker family — no write-gate token is required, and no destructive
operation exists on this surface.

### `mai_receipt_add`

Input: `{ receipt: { receiptKey, kind, cycleId, schemaVersion, planId?, pass?, …consumer fields } }`

- `receiptKey`: string, 1–256 chars — the idempotency key within the pinned project.
- `kind`: consumer-owned bounded token, `^[a-z][a-z0-9_-]{0,63}$`. mai-mcp
  validates shape boundaries, never consumer semantics — the vocabulary
  (`cycle_start`, `freeze`, `dispatch`, `delivery`, `result`, `park`,
  `decision`, `approval_committed`, …) belongs to the consumer.
- `cycleId`: string, 1–128 chars. `schemaVersion`: string, 1–64 chars.
- `pass`: positive integer or null. Optional.
- `planId`: optional string UUID. **Loud linking:** a provided planId that does
  not resolve to a registered plan in the pinned project is a validation error,
  never a silent NULL. Omit the key entirely for a plan-less receipt; an
  explicit `planId: null` is rejected.
- The entire `receipt` object is the payload, stored verbatim. Cap: **256 KiB**
  of JSON. Unknown top-level parameters beside `receipt` are rejected.

Result JSON (`ReceiptAddResult`): `{ ok: true, id, duplicate }`.

**Byte-conflict idempotency:** a byte-identical replay of an existing
`receiptKey` succeeds as a no-op (`duplicate: true`, original id) — including
after the referenced plan has been deleted (replay is checked before planId
resolution). A duplicate key with a *different* payload returns the conflict
envelope below; it is never a silent no-op. Receipts survive plan deletion
(`plan_id` becomes null); rows are never updated or deleted.

### `mai_artifact_put`

Input: `{ kind, content }` — `kind` uses the same token grammar; `content` is
non-empty UTF-8 text, cap **4 MiB**. Binary content is out of contract /2.

Result JSON (`ArtifactPutResult`): `{ ok: true, id, sha256, byteLength, duplicate }`.

Identity **is** the SHA-256 of the UTF-8 bytes — any client computes the
address independently; there is no cross-repo ID-derivation scheme. Put is
idempotent: same bytes, same row. Artifacts are **immutable and permanent** —
no release, delete, or tombstone operation exists anywhere in this contract.

### Machine error envelope

Domain failures on the three machine tools (`mai_receipt_add`, `mai_receipts`,
`mai_artifact_put`) return structured JSON text as a **non-error** result:

```json
{ "ok": false, "error": "conflict" | "validation", "message": "…" }
```

The bridge exits 0 and the consumer branches on the parsed `error` field. An
`isError` prose response (`mai-mcp error: …`) means infrastructure failure —
database outage or storage fault — and is retryable. No coordination nudge
prose is ever appended to these three tools' responses.

## Read entry: `build/read-call.js`

```
node build/read-call.js <fn> '<json-args>'
```

stdout carries exactly one JSON document; diagnostics go to stderr. The
project pin (`MAI_PROJECT_SLUG`, lowercase kebab-case) is checked purely
**before any DB access** — a missing, empty, or malformed slug is exit 2, never
a query against a default database (the entrypoint-fatal `requirePinnedSlug` is
deliberately not called). Termination drains the event loop, so piped output is
never truncated.

Functions:

| fn | args | result |
|---|---|---|
| `ping` | `{}` | `{ ok, contract, projectId, build: { version, sha, dirty, builtAt } \| null }` |
| `plan_state` | `{ path }` | `{ planId, path, status, currentSha, passes[], findings[] }` |
| `findings` | `{ plan_id }` or `{ ids: [1–128] }` | `{ findings[], missingIds?[] }` — full issue/evidence/fix rows; `missingIds` echoes caller tokens verbatim, request order preserved |
| `receipts` | `{ plan_id \| cycle_id, cursor?, limit? }` | `{ receipts[], nextCursor }` — the uncapped machine ledger read |
| `review_state` | `{ review_id }` | `{ reviewId, pass, kind, verdict, planId, planSha, reviewerAgent, findings[] }` |
| `board_thread` | `{ thread_id, cursor?, limit? }` | `{ messages[], nextCursor }` |
| `artifact` | `{ sha256 }` | `{ kind, sha256, byteLength, content }` |

**Cursor semantics** (`receipts`, `board_thread`): cursors are opaque base64url
tokens, **stream-bound** (a cursor minted for one plan/cycle/thread stream in
one project is rejected on any other stream with
`cursor does not belong to this stream`) and **microsecond-exact** (the
timestamp round-trips PostgreSQL microsecond precision as text; it never passes
through a millisecond-truncating date type). Pages are oldest-first, `limit`
≤ 200 (default 100). `nextCursor: null` means the stream is complete — there is
no silent truncation.

**Exit codes** (the exported `EXIT` taxonomy):

| code | meaning |
|---|---|
| 0 | ok — stdout holds the complete JSON document |
| 2 | validation or configuration error (bad args, bad/missing project pin) |
| 3 | not found — the addressed record exists nowhere |
| 4 | project mismatch — the record exists under **another** project |
| 5 | database failure (retryable infrastructure) |

## Explicit non-guarantees

- **No cross-store atomic transactions.** Consumers sequence idempotent effects
  and recover by replaying their own receipt ledger.
- **UTF-8 text artifacts only**; binary content is out of contract /2.
- **Artifacts are permanent.** No release/delete exists; retention and cleanup
  are an operator concern outside this contract, and long-term storage growth
  is therefore not bounded by mai-mcp.
- **MCP-side `mai_receipts` is a budget-capped human convenience.** A page that
  fits the read budget is complete JSON; a larger page carries the standard
  truncation pointer directing to `build/read-call.js receipts`. Machines use
  read-call, never the MCP read, for the ledger.
