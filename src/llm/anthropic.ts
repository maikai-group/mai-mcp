// Anthropic provider — forced tool-use gives schema-enforced structured output.
// Default behaviour of the pre-refactor summarizer (claude-sonnet-4-6) is preserved.
import Anthropic from '@anthropic-ai/sdk';
import { resolveCredential } from '../providers/runtime.js';
import type { JSONSchema, LLMProvider } from './provider.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number;
  }): Promise<unknown | null> {
    try {
      const key = await resolveCredential('anthropic');
      if (!key) return null;
      const client = new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com' });
      const response = await client.messages.create({
        model: this.model,
        max_tokens: args.maxTokens,
        tools: [
          {
            name: args.schemaName,
            description: 'Return the result as structured data conforming to the schema.',
            input_schema: args.schema, // JSONSchema is assignable to Tool.InputSchema
          },
        ],
        tool_choice: { type: 'tool', name: args.schemaName },
        messages: [{ role: 'user', content: args.prompt }],
      });
      const block = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );
      return block ? block.input : null;
    } catch (err) {
      console.warn('[mai-llm] Anthropic completeJSON failed: provider_error');
      return null;
    }
  }
}
