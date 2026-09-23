# Claude Code passing-test shadow hook

`mai tokens shadow-test` is an optional Claude Code `PostToolUse` hook. It inspects a successful `Bash` result from a direct `npx vitest run` or `pytest` command. For a verbose, unambiguous pass, it stores the exact original stdout in a private local receipt and measures a shorter candidate. The command prints nothing in normal hook use, so Claude still receives the original tool result. This is a shadow measurement, not an active rewrite.

## Manual opt-in

Merge this entry into your existing Claude Code settings, preserving every other hook and its order. Use the installed absolute path to `mai` if it is not on Claude Code's hook `PATH`. Do not replace an existing `hooks` object or another `PostToolUse` entry.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "mai tokens shadow-test" }
        ]
      }
    ]
  }
}
```

To roll back, remove only that MAI-owned `PostToolUse` entry. No automatic settings edit or install command is provided. The hook is silent on success and skip and exits successfully on malformed input or receipt-store failure. It reads at most 1 MiB of hook JSON.

For local inspection outside the hook, `mai tokens shadow-test --json` returns only a skip reason or candidate character counts and receipt ID. It never prints the command or test output. The candidate is hypothetical; characters are a size proxy, not measured model tokens or cost savings.

## Receipts

Receipts live at `~/.mai/token-shadow` by default, or at `MAI_TOKEN_RECEIPTS_DIR` if set. The directory and files are owner-only on POSIX systems. A receipt contains exact original stdout, a SHA-256 hash, byte and character counts, its source category, and creation and expiry times. Receipts expire after seven days.

`mai tokens show <uuid>` writes the exact original stdout without adding a newline, after verifying the receipt's ownership, hash, byte count, schema and expiry. `mai tokens cleanup` removes only expired, valid, owned receipts and prints the count removed. Unknown, malformed, symlinked and unowned entries are left alone.

The parser accepts only direct `npx vitest run` and `pytest` commands with simple path arguments. It skips npm scripts such as `npm test`, failures, stderr, interruption, image or binary-like output, colored ANSI output, missing terminal pass summaries, and results outside the size bounds. This conservative policy avoids summarizing only the last stage of a multi-stage command.

Installed Claude Code 2.1.258 hook acceptance has not been tested in a live session. Claude Desktop Code parity is also unverified. An active result rewrite and any claim of reduced whole-task tokens require later opt-in compatibility and paired-task evidence.

## MAI read shadow

The MCP server also measures hypothetical shorter versions of broad `mai_findings` lists and read-only `mai_plan` summaries. It renders each candidate from the rows or plan record already fetched and keeps the actual reply unchanged for Codex and Claude. Status writes, errors, structured results, `finding:"UUID[:part]"` pages and `pass:"N[:part]"` pages are excluded. Those exact selectors remain the recovery routes for details omitted from a candidate.

The existing MCP reply has a 6,000-character cap. A candidate must fit 3,000 characters before the wire finalizer, retain every shown finding headline or plan review identity and recovery instruction, and be strictly shorter after the same coordination nudge is applied. Candidates are measured only; the server never sends them to a host.

`mai tokens shadow-report` displays aggregate attempts, candidates, skips and character counts by tool. Add `--json` for the versioned aggregate object. Its `proxy` and `hypothetical` labels matter: fewer characters in a hypothetical reply are **not** measured model tokens, subscription usage, or cost savings.

The local log is `~/.mai/token-shadow/mai-read.jsonl`, or `MAI_TOKEN_RECEIPTS_DIR/mai-read.jsonl` when that override is set. It stores only time, tool, policy, character counts and a bounded skip reason. It contains no query, result text, finding ID, plan path, chat identity or model name. The directory is owner-only, the log and cross-process lock use owner-only files on POSIX, and appends stop at 2 MiB. Logging contention, a stale lock or an unsafe path silently leaves MCP replies alone; a missing or unsafe log is reported as unavailable.

An active shorter reply mode would need an explicit opt-in and paired whole-task trials that check task correctness, exact recovery, total token counters, follow-up fetches, compactions and latency. The shadow report alone does not establish a saving.
