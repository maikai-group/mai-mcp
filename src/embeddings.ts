// Origin: forked from the Mai Group's predecessor memory server (private).
/**
 * Brain 2 embeddings — semantic search infrastructure.
 *
 * Env gates:
 *   MAI_EMBEDDINGS=1  — master switch
 *   Plus ONE provider key:
 *     OPENAI_API_KEY  → text-embedding-3-small (1536d)  [default]
 *     VOYAGE_API_KEY  → voyage-3 (1024d)                [alternative]
 *
 * If any of those are missing, embed() returns null and similarity search
 * degrades gracefully ("embeddings disabled" message).
 *
 * Storage: DOUBLE PRECISION[] + embedding_model TEXT on
 * code_decisions.embedding and lessons.embedding. Similarity: cosine in Node.
 * Readers filter by embedding_model; writers stamp it (plan 14).
 */

import OpenAI from "openai";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

type Provider = "openai" | "voyage" | "local" | null;

export const LOCAL_EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const LOCAL_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";
export const LOCAL_MODEL_DIR = () =>
  path.join(os.homedir(), ".mai-mcp", "models");

// Cached resolvability probe (review B4): configured ≠ usable — the plan-13
// claudeBinaryAvailable() precedent. Without this, embeddingsEnabled() returns
// true when the optional dep never installed, lessons.ts takes the semantic
// dedup branch, embed() nulls, and dedup silently disables entirely.
let localResolvable: boolean | null = null;
function localDepResolvable(): boolean {
  if (localResolvable !== null) return localResolvable;
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    localResolvable = true;
  } catch {
    localResolvable = false;
  }
  return localResolvable;
}

/** A key is a key only if it is non-empty after trimming (pass-7 B4). Exported
 * so the consent flow uses the SAME predicate — two definitions of "has a cloud
 * key" is exactly how the tier a user runs and the tier they were offered came
 * apart. Note this also tightens detection itself: bare truthiness treated
 * `"   "` as a key, selecting a cloud tier that then failed on every call. */
export function hasCloudKey(v: string | undefined): boolean {
  return (v ?? "").trim() !== "";
}

function detectProvider(): Provider {
  if (process.env.MAI_EMBEDDINGS !== "1") return null;
  if (hasCloudKey(process.env.OPENAI_API_KEY)) return "openai";
  if (hasCloudKey(process.env.VOYAGE_API_KEY)) return "voyage";
  // Keyless tier — only when the dep can actually load; model availability
  // (downloaded/fetchable) still checked lazily in embed().
  return localDepResolvable() ? "local" : null;
}

/** Stable per-provider model id — stamped on writes, filtered on reads. */
export function currentEmbeddingModelId(): string | null {
  switch (detectProvider()) {
    case "openai": return "openai:text-embedding-3-small";
    case "voyage": return "voyage:voyage-3";
    case "local":  return `local:${LOCAL_EMBED_MODEL.split("/")[1]}`;
    default:       return null;
  }
}

// ---------- local tier ----------
type LocalEmbedFn = (text: string) => Promise<number[] | null>;
/** undefined = untried (a failed attempt resets to this so the NEXT call can
 * retry — pass-5 W1); a set fn = ready. There is deliberately no `null` "dead
 * forever" state: spec §3/§7 promise "retried next call". */
let localFn: LocalEmbedFn | undefined;
let localInitPromise: Promise<void> | null = null;
/** Why the last attempt failed — drives embeddingsStatus()'s honest message
 * (pass-5 W2: blaming the optional dependency for a network failure sends the
 * user to fix an install that is fine). */
type LocalFailure = "dep" | "download" | "timeout" | "inference" | null;
let localFailure: LocalFailure = null;
/** The bound the FAILED attempt actually used (pass-7 W2): the status line
 * hardcoded LOCAL_INIT_TIMEOUT_MS, so a timeout from the 180s consent download
 * reported "exceeded 20000ms". */
let localFailureMs = 0;
/** Epoch ms before which we do NOT re-attempt. Retry-next-call (W1) without
 * this would make every embed() on a broken install pay the full timeout. */
let localRetryAfter = 0;

// Bounded external waits (pass-5 B2). Precedents: db.ts:5 ("every wait is
// bounded" — the 2026-07-14 mai_prime freeze fix) and claude-code.ts's
// CC_TIMEOUT_MS. initLocal() is awaited inside embed(), which is awaited
// inside mai_lesson_add / mai_remember / mai_search and inside `mai init`.
const LOCAL_INIT_TIMEOUT_MS = 20_000;      // lazy first use: fail fast, retry later
const LOCAL_DOWNLOAD_TIMEOUT_MS = 180_000; // explicit init-consent fetch: room for a real ~35MB download
const LOCAL_RETRY_COOLDOWN_MS = 60_000;

// ---------- cloud tier bounds (plan 14b) ----------
// Plan 14 bounded the LOCAL tier and left the cloud tiers unbounded: a bare
// fetch with no AbortSignal, and the OpenAI SDK's ~10-minute default. Both sit
// behind mai_search — the token-minting read before every Cat A write — so a
// wedged connection stalls an agent indefinitely. db.ts:5 is the standing
// doctrine: every wait is bounded.
//
// 5s is an INITIAL OPERATIONAL BOUND, not a measured one (pass-3 W1): no p99
// latency evidence has been gathered for either provider, and an earlier draft
// of this comment claimed "an order of magnitude above p99" without it. The
// number is chosen as comfortably above interactive expectation and is meant to
// be revised once embeddingsStatus() surfaces real timeout counts.
// Exceeding it is NOT a quality failure: embed() returns null and the caller
// falls back to trigram, which still mints the write-gate token.
//
// DELIBERATELY NOT an env knob. A published env var can never be removed,
// while a knob can always be added once real demand exists — so the absence
// is the reversible choice. embeddingsStatus() names this value when the
// bound fires, which is how that demand would show up as evidence.
const CLOUD_EMBED_TIMEOUT_MS = 5_000;

/** Consecutive failures before the cloud tier is skipped. ONE failure is a
 * blip; cooling down on it would down-tier the whole brain for a transient.
 * TWO in a row is an outage, where paying the full timeout on every search
 * (an agent loop does dozens) is the worse failure. This gate is why the
 * cloud cooldown differs from the local tier's: a missing model file is
 * persistent, a network blip is not. */
const CLOUD_FAIL_THRESHOLD = 2;
const CLOUD_COOLDOWN_MS = 30_000;
let cloudConsecutiveFailures = 0;
let cloudRetryAfter = 0;
/** How many of the CURRENT consecutive-failure run were timeouts. A COUNT, not
 * a boolean (pass-2 W3): a sticky flag made one timeout followed by one HTTP
 * 500 report "2 consecutive timeouts", sending the operator to debug latency
 * when half the evidence was a server error. Distinguishing "slow" from
 * "erroring" is the entire job of this field, so it must not conflate them. */
let cloudTimeoutFailures = 0;

function noteCloudResult(ok: boolean, timedOut = false): void {
  if (ok) {
    cloudConsecutiveFailures = 0;
    cloudRetryAfter = 0;
    cloudTimeoutFailures = 0;
    return;
  }
  cloudConsecutiveFailures++;
  if (timedOut) cloudTimeoutFailures++;
  if (cloudConsecutiveFailures >= CLOUD_FAIL_THRESHOLD) {
    cloudRetryAfter = Date.now() + CLOUD_COOLDOWN_MS;
  }
}

/** Test seam — mirrors db.ts's __resetProjectIdCacheForTests convention. */
export function __resetCloudTierForTests(): void {
  cloudConsecutiveFailures = 0;
  cloudRetryAfter = 0;
  cloudTimeoutFailures = 0;
}

/** Bounded wait helper (pass-5 B2). The underlying promise is ABANDONED, not
 * cancelled — transformers.js exposes no abort handle; the point is that the
 * caller stops waiting, not that the fetch stops. Exported so the bound itself
 * is directly testable without a real model. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test hook: inject a fake embedder (pass null to reset to untried). Forces
 * the resolvability probe true (the fake needs no real dep — public clones run
 * these tests without it) and clears the embed cache (review N3: cached
 * vectors from an earlier fake otherwise leak across describes — the cache
 * key is provider|text and the provider stays 'local'). Also clears the
 * failure/cooldown state so an injected fake is never gated by a real earlier
 * failure (pass-5). */
export function setLocalEmbedderForTests(fn: LocalEmbedFn | null): void {
  localFn = fn ?? undefined;
  localInitPromise = null;
  localResolvable = fn ? true : null;
  localFailure = null;
  localRetryAfter = 0;
  CACHE.clear();
}

async function initLocal(timeoutMs: number): Promise<void> {
  try {
    // Optional dependency — dynamic import so a failed install never breaks
    // build/tests (spec §3). Cache stays inside mai's own directory.
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = LOCAL_MODEL_DIR();
    const pipe = await withTimeout(
      t.pipeline("feature-extraction", LOCAL_EMBED_MODEL, { dtype: "q8" }),
      timeoutMs,
      "local model load"
    );
    localFn = async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(out.data); // typed Float32Array via the ambient declaration — no cast (review W6)
    };
    localFailure = null;
    localRetryAfter = 0;
  } catch (err) {
    noteLocalFailure(err, timeoutMs);
  } finally {
    localInitPromise = null;
  }
}

/** Single place that records a local-tier failure — used by BOTH the load path
 * and the inference path (pass-7 B2). Resets to untried + arms the cooldown:
 * the next call after the cooldown retries (spec §3/§7), so a transient offline
 * start does not disable the tier for the life of a long-running MCP server
 * process (pass-5 W1). */
function noteLocalFailure(err: unknown, timeoutMs: number, kind?: LocalFailure): void {
  // Native bindings and worker boundaries do not guarantee Error rejections.
  // This function runs INSIDE the catch that enforces embed() -> null, so it
  // must itself be total over unknown or the fallback contract is defeated.
  const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  localFailure =
    kind ??
    (msg.includes("exceeded")
      ? "timeout"
      : /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(msg)
        ? "dep"
        : "download");
  localFailureMs = timeoutMs;
  console.warn("[brain2-embed] local embedder unavailable:", msg);
  localFn = undefined;
  localRetryAfter = Date.now() + LOCAL_RETRY_COOLDOWN_MS;
}

async function embedLocal(text: string, timeoutMs = LOCAL_INIT_TIMEOUT_MS): Promise<number[] | null> {
  if (localFn === undefined && !localInitPromise) {
    if (Date.now() < localRetryAfter) return null; // cooling down after a failure
    localInitPromise = initLocal(timeoutMs);
  }
  if (localInitPromise) await localInitPromise;
  if (!localFn) return null;
  try {
    // INFERENCE, not just loading, must honour the embed() → null contract
    // (pass-7 B2). Only the load was guarded before, so a rejected forward pass
    // — corrupt cached .onnx, OOM, worker crash — propagated out of embed()
    // into mai_lesson_add / mai_remember / mai_search as a tool error, and the
    // trigram fallback this plan spent three passes building never ran.
    // embedOpenAI and embedVoyage each guard their own call; local was the
    // only tier that did not. Bounded too: a wedged forward pass is a hang.
    return await withTimeout(localFn(text.slice(0, 8000)), timeoutMs, "local embed");
  } catch (err) {
    // Reset the pipeline as well as the state — an inference failure usually
    // means the loaded pipeline itself is unusable, so the post-cooldown retry
    // should rebuild it rather than call the same broken object again.
    noteLocalFailure(err, timeoutMs, "inference");
    return null;
  }
}

/** Init-time model prefetch (consent flow) — loads the pipeline once, which
 * downloads the model if absent. Returns true when the local tier is ready.
 * Uses the long bound and ignores any cooldown: this is an explicit, blocking,
 * user-initiated action, not an incidental embed. */
export async function downloadLocalModel(): Promise<boolean> {
  localRetryAfter = 0;
  // Return whether the tier can actually EMBED, not merely whether a function
  // got assigned — a loaded pipeline that returns nothing is not "ready", and
  // rebuild's pass-6 B1 preflight depends on this distinction being real.
  return (await embedLocal("warmup", LOCAL_DOWNLOAD_TIMEOUT_MS)) !== null;
}

export function embeddingsEnabled(): boolean {
  return detectProvider() !== null;
}

/** Are the ONNX weights actually on disk? (pass-7 W1.) Matches by extension
 * rather than hardcoding `model_quantized.onnx`, so a transformers.js naming
 * change degrades to "looks downloaded" rather than a permanent false alarm —
 * and the gated MAI_TEST_LOCAL_EMBED=1 run confirms the real filename once. */
function localWeightsPresent(): boolean {
  const dir = path.join(LOCAL_MODEL_DIR(), LOCAL_EMBED_MODEL, "onnx");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".onnx"))
      .some((f) => fs.statSync(path.join(dir, f)).size > 0);
  } catch {
    return false; // ENOENT — nothing fetched yet
  }
}

export function embeddingsStatus(): string {
  if (process.env.MAI_EMBEDDINGS !== "1") {
    return "disabled — set MAI_EMBEDDINGS=1 to enable.";
  }
  const p = detectProvider();
  if (!p) {
    // Flag on + no cloud key + probe false is the ONLY way detectProvider()
    // returns null here (pass-4 N7 collapsed the unreachable other arm).
    return "local tier unavailable (optional dependency @huggingface/transformers not installed) — trigram fallback active.";
  }
  if (p === "local") {
    // Distinct causes, distinct advice (pass-5 W2; spec §6 names "model not
    // yet downloaded" as a required status).
    switch (localFailure) {
      case "dep":
        return "local tier failed to load (optional dependency present but not loadable) — trigram fallback active.";
      case "timeout":
        // localFailureMs, not the constant (pass-7 W2): a timeout on the 180s
        // consent download otherwise reported "exceeded 20000ms".
        return `local model not yet downloaded (load exceeded ${localFailureMs}ms) — retrying on a later call; trigram fallback active.`;
      case "download":
        return "local model not yet downloaded (fetch failed — check network) — retrying on a later call; trigram fallback active.";
      case "inference":
        return "local model loaded but failed to embed (cache may be corrupt — delete ~/.mai-mcp/models to refetch) — retrying on a later call; trigram fallback active.";
      default:
        // localFailure is null in ANY process that has not yet attempted an
        // embed — which is EVERY `mai verify` run (pass-6 W1). Without this
        // disk check the one command meant to diagnose a failed download
        // reports a confident "enabled" whether the model exists or not.
        // Check the WEIGHTS, not the directory (pass-7 W1): transformers.js
        // caches each requested file separately under <cacheDir>/<org>/<model>,
        // so a run that fetched tokenizer.json/config.json and then failed on
        // the ~35MB .onnx leaves a directory that exists and a tier that cannot
        // embed — the precise state this check exists to catch.
        if (!localWeightsPresent()) {
          return `local model not yet downloaded (no weights under ${path.join(LOCAL_MODEL_DIR(), LOCAL_EMBED_MODEL, "onnx")}) — downloads on first use; trigram fallback until then.`;
        }
        return `enabled — provider: local (${LOCAL_EMBED_MODEL}, cache: ${LOCAL_MODEL_DIR()})`;
    }
  }
  // Cloud degradation must be visible: a silently down-tiered brain that
  // reports a confident "enabled" is the exact failure mode plan 14's local
  // status switch was written to avoid (pass-6 W1).
  if (cloudConsecutiveFailures >= CLOUD_FAIL_THRESHOLD) {
    const remaining = Math.max(0, cloudRetryAfter - Date.now());
    // Report the timeout count, never "all of them were timeouts" (pass-2 W3).
    const detail =
      cloudTimeoutFailures === cloudConsecutiveFailures
        ? `timeouts (bound ${CLOUD_EMBED_TIMEOUT_MS}ms)`
        : cloudTimeoutFailures > 0
          ? `failures, ${cloudTimeoutFailures} of them timeouts (bound ${CLOUD_EMBED_TIMEOUT_MS}ms)`
          : "failures";
    return (
      `enabled — provider: ${p}, but DEGRADED: ${cloudConsecutiveFailures} consecutive ${detail} — ` +
      `skipping the provider for ${Math.ceil(remaining / 1000)}s; trigram fallback active.`
    );
  }
  if (cloudConsecutiveFailures > 0) {
    return `enabled — provider: ${p} (${cloudConsecutiveFailures} recent failure(s), ${cloudTimeoutFailures} timeout(s); bound ${CLOUD_EMBED_TIMEOUT_MS}ms)`;
  }
  return `enabled — provider: ${p}`;
}

/** Per-provider dedup threshold (pass-6 B3). Cosine scores are NOT comparable
 * across models — BAAI's bge card states that only relative ranking transfers,
 * not the absolute value — so the 0.85 tuned for text-embedding-3-small cannot
 * be carried onto bge-small unexamined.
 *
 * MEASURED 2026-08-09 by the gated MAI_TEST_LOCAL_EMBED=1 calibration run
 * (Task 6 Step 3) against the real bge-small-en-v1.5 q8 pipeline:
 *   NEAR-DUP   0.867, 0.724
 *   UNRELATED  0.555, 0.589
 * The classes separate (highest UNRELATED 0.589 < lowest NEAR-DUP 0.724), so
 * per the plan's threshold-selection policy 1 the local value is the midpoint,
 * 0.66 — replacing the 0.92 placeholder, which sat above every measured
 * near-duplicate and would therefore have deduped nothing on this tier.
 * Re-run the calibration on any model bump; the two failure directions are not
 * symmetric (too high = a duplicate lesson, visible and fixable; too low =
 * silently reinforcing the WRONG lesson and dropping the intended write). */
export function dedupCosineThreshold(): number {
  return detectProvider() === "local" ? 0.66 : 0.85;
}

/** Apply one public result limit to incomparable semantic and stale-text
 * result sets. When both exist and the caller has at least two slots, one stale
 * slot is guaranteed so a mixed corpus cannot hide rebuild debt; at limit=1,
 * preserve the feature's semantic result rather than returning stale-only. */
export function budgetHybridHits<S, T>(
  semantic: S[], stale: T[], requestedLimit: number
): { semantic: S[]; stale: T[] } {
  const limit = Math.max(0, Math.floor(requestedLimit));
  if (limit === 0) return { semantic: [], stale: [] };
  if (semantic.length === 0) return { semantic: [], stale: stale.slice(0, limit) };
  if (stale.length === 0) return { semantic: semantic.slice(0, limit), stale: [] };
  const staleReserve = limit >= 2 ? 1 : 0;
  const selectedSemantic = semantic.slice(0, limit - staleReserve);
  const selectedStale = stale.slice(0, limit - selectedSemantic.length);
  return { semantic: selectedSemantic, stale: selectedStale };
}

// In-memory LRU-ish cache to avoid re-embedding identical strings within a process.
const CACHE = new Map<string, number[]>();
const MAX_CACHE = 500;

function cacheGet(text: string): number[] | undefined {
  return CACHE.get(text);
}

function cacheSet(text: string, vec: number[]): void {
  if (CACHE.size >= MAX_CACHE) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
  CACHE.set(text, vec);
}

async function embedOpenAI(text: string): Promise<number[] | null> {
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: CLOUD_EMBED_TIMEOUT_MS,
      maxRetries: 0, // deterministic wall time — see note above
    });
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    });
    const vec = response.data[0]?.embedding ?? null;
    noteCloudResult(vec !== null);
    return vec;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    noteCloudResult(false, /timed? ?out|timeout/i.test(msg));
    console.warn("[brain2-embed] OpenAI embed failed:", msg.split("\n")[0]);
    return null;
  }
}

async function embedVoyage(text: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "voyage-3",
        input: [text.slice(0, 8000)],
      }),
      // Native cancellation: the request is actually aborted, unlike the
      // local tier's withTimeout, which can only stop waiting.
      signal: AbortSignal.timeout(CLOUD_EMBED_TIMEOUT_MS),
    });
    if (!response.ok) {
      noteCloudResult(false);
      console.warn(
        "[brain2-embed] Voyage embed failed:",
        response.status,
        await response.text()
      );
      return null;
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = data.data?.[0]?.embedding ?? null;
    noteCloudResult(vec !== null);
    return vec;
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    noteCloudResult(false, timedOut);
    console.warn("[brain2-embed] Voyage embed error:", err);
    return null;
  }
}

export async function embed(text: string): Promise<number[] | null> {
  const provider = detectProvider();
  if (!provider) return null;
  if (!text || !text.trim()) return null;

  const key = `${provider}|${text}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Cloud cooldown (R5): after CLOUD_FAIL_THRESHOLD consecutive failures the
  // provider is presumed down. Skipping it keeps search fast on trigram
  // instead of paying CLOUD_EMBED_TIMEOUT_MS on every call.
  if ((provider === "openai" || provider === "voyage") && Date.now() < cloudRetryAfter) {
    return null;
  }

  const vec =
    provider === "openai" ? await embedOpenAI(text)
    : provider === "voyage" ? await embedVoyage(text)
    : await embedLocal(text);
  if (vec) cacheSet(key, vec);
  return vec;
}

/** Embed a retrieval query. BGE recommends an instruction on the query only;
 * passages and symmetric similarity inputs must remain unprefixed. */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!text || !text.trim()) return null;
  return embed(detectProvider() === "local" ? `${LOCAL_QUERY_PREFIX}${text}` : text);
}

// ---------- Cosine similarity ----------

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}
