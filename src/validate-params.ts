/**
 * Boundary validation for MCP tool params.
 *
 * The MCP SDK's low-level server API does NOT enforce inputSchema, and the
 * client doesn't either — params arrive exactly as the agent sent them. The
 * dispatch layer used to blind-cast, so a missing or misnamed param surfaced
 * as a TypeError deep in the call path ("Cannot read properties of undefined")
 * that reads as a server bug. Live consequence (2026-06-12): an agent dropped
 * `evidence` from mai_progress, diagnosed the TypeError as an internal server
 * error, and abandoned the capture — the exact adoption failure Plan 5 targets.
 *
 * The rejection message names the missing params, echoes what WAS passed, and
 * calls out unrecognized keys, so a wrong-key mistake (`summary` instead of
 * `milestone`) self-corrects on the next attempt.
 */
export interface ToolParamSpec {
  required: string[];
  optional: string[];
}

/** Derive a param spec from a tool's JSON inputSchema (single source of truth). */
export function specFromInputSchema(schema: {
  properties?: Record<string, unknown>;
  required?: readonly string[];
}): ToolParamSpec {
  const required = [...(schema.required ?? [])];
  const optional = Object.keys(schema.properties ?? {}).filter((k) => !required.includes(k));
  return { required, optional };
}

/**
 * Throw a self-correcting error if any required param is absent. null counts
 * as missing — JSON payloads carry null, not undefined. Extra keys alone don't
 * reject (the call can still succeed); they're only named as the likely
 * culprit when a required param IS missing.
 */
export function validateRequiredParams(
  toolName: string,
  params: Record<string, unknown>,
  spec: ToolParamSpec
): void {
  const missing = spec.required.filter((k) => params[k] === undefined || params[k] === null);
  if (missing.length === 0) return;

  const passedKeys = Object.keys(params).filter((k) => params[k] !== undefined);
  const unrecognized = passedKeys.filter(
    (k) => !spec.required.includes(k) && !spec.optional.includes(k)
  );

  const parts = [
    `${toolName}: missing required parameter${missing.length > 1 ? 's' : ''}: ` +
      missing.map((k) => `'${k}'`).join(', ') + '.',
    passedKeys.length > 0 ? `You passed: ${passedKeys.join(', ')}.` : 'You passed no parameters.',
  ];
  if (unrecognized.length > 0) {
    parts.push(
      `Unrecognized: ${unrecognized.join(', ')} — check the parameter names against the tool schema.`
    );
  }
  parts.push(
    `Expected parameters: ` +
      spec.required.map((k) => `${k} (required)`).concat(spec.optional).join(', ') + '.'
  );
  throw new Error(parts.join(' '));
}

/**
 * Tool-call serialization markup that must NEVER appear inside an argument
 * value. When it does, the model merged several parameters into one string —
 * observed live (2026-06-17, against a consumer project): `reasoning` and `source` collapsed
 * INTO `description` as escaped `</parameter><parameter name="...">` XML, while
 * `citation`/`tags` parsed fine. The merged ~1300-char blob trips the 1000 char
 * limit, so the agent shaves prose and retries forever — the param tags stay,
 * so it's permanently over-limit AND malformed (6+ retries, tokens each). The
 * generic "too long" error sends it trimming; this names the real fix.
 */
const MERGED_PARAM_RE = /<\/parameter>|<parameter\s+name\s*=|<\/antml:parameter>|<parameter\b/i;

/** Throw a corrective error if any string field carries leaked parameter markup
 * (scans nested objects too, e.g. citation). Cheap pre-check at dispatch. */
export function rejectMergedParams(toolName: string, params: Record<string, unknown>): void {
  const offenders: string[] = [];
  const scan = (key: string, val: unknown): void => {
    if (typeof val === 'string') {
      if (MERGED_PARAM_RE.test(val)) offenders.push(key);
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) scan(`${key}.${k}`, v);
    }
  };
  for (const [k, v] of Object.entries(params)) scan(k, v);
  if (offenders.length === 0) return;
  throw new Error(
    `${toolName}: parameter${offenders.length > 1 ? 's' : ''} ${offenders.map((o) => `'${o}'`).join(', ')} ` +
      `contain literal tool-call markup ("</parameter>", '<parameter name="...">'). This is NOT your content — ` +
      `the harness leaked parameter separators into the value, which happens when one call carries several ` +
      `parameters at once. FIX: re-send with ONLY the required parameters (drop optional ones like reasoning, ` +
      `source, tags) — a smaller call avoids the concatenation; capture extra detail in a separate follow-up ` +
      `call. Do NOT trim the text — the markup, not the length, is the problem.`
  );
}
