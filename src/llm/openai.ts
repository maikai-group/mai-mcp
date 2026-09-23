// OpenAI provider — serves both `openai` (api.openai.com) and `openai-compatible`
// (Ollama / local / OpenRouter, selected by a baseURL). Uses json_schema structured
// output; if a compatible endpoint rejects json_schema, it degrades ONCE (for the
// life of the process) to prompt-JSON parsing.
import OpenAI from 'openai';
import { resolveCredential } from '../providers/runtime.js';
import { extractJSON } from './json.js';
import type { JSONSchema, LLMProvider } from './provider.js';

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  private readonly model: string;
  private readonly baseURL?: string;
  // Set once a compatible endpoint has rejected json_schema → skip it thereafter.
  private schemaUnsupported = false;

  constructor(opts: { model: string; baseURL?: string }) {
    this.model = opts.model;
    this.baseURL = opts.baseURL;
    this.name = opts.baseURL ? 'openai-compatible' : 'openai';
  }

  async completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number;
  }): Promise<unknown | null> {
    let client: OpenAI;
    try {
      const key=this.baseURL?process.env.OPENAI_API_KEY??'not-needed':await resolveCredential('openai');
      if(!this.baseURL&&!key)return null;
      client=new OpenAI({apiKey:key??'not-needed',baseURL:this.baseURL??'https://api.openai.com/v1'});
    } catch { console.warn('[mai-llm] OpenAI credential unavailable'); return null; }

    if (!this.schemaUnsupported) {
      try {
        const response = await client.chat.completions.create({
          model: this.model,
          max_tokens: args.maxTokens,
          messages: [{ role: 'user', content: args.prompt }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: args.schemaName, schema: args.schema, strict: true },
          },
        });
        const content = response.choices[0]?.message?.content;
        return content ? extractJSON(content) : null;
      } catch (err) {
        if (!this.baseURL) {
          console.warn('[mai-llm] OpenAI completeJSON failed: provider_error');
          return null;
        }
        // Compatible endpoint likely lacks json_schema — remember + fall through.
        this.schemaUnsupported = true;
        console.warn('[mai-llm] json_schema unsupported by endpoint; using prompt-JSON.');
      }
    }

    // Fallback: plain completion; the prompt already instructs "return STRICT JSON".
    try {
      const response = await client.chat.completions.create({
        model: this.model,
        max_tokens: args.maxTokens,
        messages: [{ role: 'user', content: args.prompt }],
      });
      const content = response.choices[0]?.message?.content;
      return content ? extractJSON(content) : null;
    } catch (err) {
      console.warn('[mai-llm] openai-compatible fallback failed: provider_error');
      return null;
    }
  }
}
