import {
  CreateChatCompletionOptions,
  LLMClient,
  LogLine,
} from "@browserbasehq/stagehand";
import zodToJsonSchema from 'zod-to-json-schema';

type WorkersAIOptions = AiOptions & {
  logger?: (line: LogLine) => void;
};

const modelId = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

/**
 * WorkersAIClient — Bridges Stagehand's LLMClient to Cloudflare Workers AI.
 *
 * Uses @cf/meta/llama-3.3-70b-instruct-fp8-fast (Meta Llama 3.3 70B).
 *
 * NOTE: Stagehand logs two harmless warnings during init():
 *   - "API key for openai not found" — Stagehand checks for OpenAI by default
 *   - "Custom LLM clients not supported in API mode" — We use LOCAL mode, not API
 * Both are cosmetic. This client works perfectly as the LLM backend.
 *
 * Includes retry logic to handle Workers AI 504 Gateway Timeouts that can
 * occur when the LLM inference takes too long on large page contexts.
 */
export class WorkersAIClient extends LLMClient {

  public type = "workers-ai" as const;
  private binding: Ai;
  private options?: WorkersAIOptions;

  constructor(binding: Ai, options?: WorkersAIOptions) {
    super(modelId);
    this.binding = binding;
    this.options = options;
  }

  async createChatCompletion<T>({ options }: CreateChatCompletionOptions): Promise<T> {
    const schema = options.response_model?.schema;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.options?.logger?.({
          category: "workersai",
          message: `thinking... (attempt ${attempt}/${MAX_RETRIES})`,
        });

        const { response } = await this.binding.run(this.modelName as keyof AiModels, {
          messages: options.messages,
          // @ts-ignore — Stagehand may pass tool definitions that CF AI supports
          tools: options.tools,
          response_format: schema ? {
            type: "json_schema",
            json_schema: zodToJsonSchema(schema),
          } : undefined,
          temperature: 0,
        }, this.options) as AiTextGenerationOutput;

        this.options?.logger?.({
          category: "workersai",
          message: "completed thinking!",
        });

        return { data: response } as T;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRetryable = errMsg.includes("504") || errMsg.includes("timeout") || errMsg.includes("Gateway");

        this.options?.logger?.({
          category: "workersai",
          message: `⚠️ attempt ${attempt} failed: ${errMsg.substring(0, 120)}`,
        });

        if (isRetryable && attempt < MAX_RETRIES) {
          console.log(`🔄 Workers AI timeout — retrying in ${RETRY_DELAY_MS / 1000}s... (${attempt}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }

        // Non-retryable or last attempt — throw
        throw err;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error("WorkersAIClient: max retries exhausted");
  }
}
