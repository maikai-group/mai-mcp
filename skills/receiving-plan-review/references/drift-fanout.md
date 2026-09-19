# Plan Repair Fan-out Matrix

Use this matrix after confirming a finding. Search the full plan for every item in the applicable row before and after editing.

| Changed concept | Required fan-out checks |
|---|---|
| Test added/removed/moved | Actual `it`/`test` count; describe subtotals; File Map; task RED; intermediate GREEN; final test-file count; baseline + delta arithmetic; skipped total; self-review |
| Function signature/return type | Declaration; exported interface; implementation; imports; every call; mocks/spies; test helpers; prose examples; expected output; type/cast gates |
| Facade/seam | Core-side type; implementation-side adapter; dependency direction; transaction ownership; test double shape; tool surface/budget if exposed |
| Transaction boundary | Connection/client owner; BEGIN/COMMIT/ROLLBACK; nested transaction avoidance; lock key/scope; project/auth predicates; failure atomicity; retry/idempotency; concurrency tests |
| Query predicate/scope | Every SELECT/UPDATE/DELETE/INSERT; project/tenant/auth key; indexes; foreign-row negative test; empty-result behavior |
| Batch/page bound | Correctness vs presentation limit; pagination termination; deterministic beyond-boundary case; overflow summary; performance rationale |
| Env/config behavior | Default/unset/blank; normalization; invalid value; warning frequency; process/module cache; test reset seam; docs in every shipped surface |
| Task/step order | Step numbers; `Depends on`; RED-before-GREEN reachability; file creation timing; cross-references; mutation ordering; commit list/pathspecs; self-review |
| File path/action | File Map; every task `Files:` block; commands; imports; exact `git add` + commit pathspecs; release manifest; docs links; create-vs-modify existence; path canonicalization |
| Requirement/policy | Header requirement; governing decision ID; architecture; tasks; tests; docs; out-of-scope; coverage map; explicit user authority for security/scope/billing/release changes |
| Migration/schema | Forward SQL; rollback; schema mirror; ordering; data survival; idempotency; catalog parity; disposable proof; live apply remains execution-only |
| Version/release | package metadata; lockfile root/package; runtime literal; manifest/assembler; README; computed bump; fail-closed sync gate |
| Verification command | Working directory; prerequisites already created; exit propagation; negative control; expected count/output; cleanup; no live/billed side effects |
| Reviewer finding wording | Finding UUID; recurrence; cited premise; stronger evidence from other passes; tracker note; no reliance on pass-local `B1` labels |

## High-value searches

Run repository-appropriate variants of:

```bash
rg -n 'oldCount|newCount|oldFunctionName|old step phrase' path/to/plan.md
rg -n '^\s*(it|test)(\.each)?\s*\(' path/to/plan.md
rg -n '^Run:|^Expected:' path/to/plan.md
rg -n 'TBD|TODO|implement later|fill in details|Add appropriate error handling|Handle edge cases' path/to/plan.md
```

Treat search results as an inventory to inspect, not an automatic failure: code examples can contain words such as TODO intentionally, and prose can state a pre-fix expected count legitimately.
