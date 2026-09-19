/** Plan 19 gated LIVE smoke (spec §6): ONE real `codex exec` structured
 * completion on the user's ChatGPT subscription. Deliberately excluded from
 * every default run — subscription-billed. Run explicitly:
 *   MAI_TEST_CODEX=1 npx vitest run src/__tests__/llm-codex-cli-live.test.ts
 * Own file (not a describe in llm-codex-cli.test.ts) because that suite pins
 * MAI_CC_TIMEOUT_MS=2000 before module load and the shared timeout constant is
 * captured at import — the live call needs the real 120s bound. */
import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.MAI_TEST_CODEX !== '1')('codex-cli live smoke (subscription-billed)', () => {
  it('real codex exec returns schema-conforming JSON via --output-schema/-o', async () => {
    const { CodexCliProvider, codexBinaryAvailable, resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    resetCodexBinaryProbe();
    expect(codexBinaryAvailable()).toBe(true); // real binary + ChatGPT login are preconditions
    const result: unknown = await new CodexCliProvider().completeJSON({
      prompt: 'Reply with ok set to true and word set to "pong".',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
        required: ['ok', 'word'],
        additionalProperties: false,
      },
      schemaName: 'ping',
      maxTokens: 100,
    });
    // Cast-free narrowing (global lesson 293a39bc).
    if (typeof result !== 'object' || result === null || !('ok' in result) || !('word' in result)) {
      throw new Error(`schema-shaped object expected, got: ${JSON.stringify(result)}`);
    }
    expect(result.ok).toBe(true);
    expect(typeof result.word).toBe('string');
  }, 180_000);
});
