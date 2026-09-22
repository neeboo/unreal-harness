/**
 * The DeepSeek client: the model half of the benchmark.
 *
 * Thin on purpose. A benchmark's model call is part of its *measurement
 * apparatus*, so anything clever here — retries that change the request, hidden
 * system prompts, tool-call scaffolding — would be a variable the comparison does
 * not account for. This client sends one chat request and reports what came back,
 * including the token accounting, because cost is half of what the benchmark
 * measures.
 *
 * # What is pinned, and why
 *
 * - **The model id.** `deepseek-flash` is the only id the API accepts for
 *   DeepSeek-V4.1-Flash; `deepseek-v41-flash` and `deepseek-v4.1-flash` both
 *   return HTTP 400. The response's `model` field is checked against what was
 *   requested so a silent substitution cannot become an unexplained result.
 * - **Reasoning effort.** Flash runs in thinking mode by default, which changes
 *   output tokens, latency, and possibly quality. It is set explicitly and
 *   recorded in every result, because a comparison between two arms that differ in
 *   effort is not a comparison.
 * @module
 */

/** The DeepSeek API base. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** The model this benchmark measures against. */
export const DEFAULT_MODEL = 'deepseek-flash'

/** Reasoning effort levels the API accepts. */
export type Effort = 'low' | 'high' | 'max'

/** What one model call cost and produced. */
export interface CompletionResult {
  /** The assistant text, with any reasoning already stripped. */
  readonly text: string
  /** Reasoning tokens the provider reported, when it separated them. */
  readonly reasoningText: string
  readonly model: string
  readonly usage: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly totalTokens: number
    /** Prompt tokens served from the provider's cache, when reported. */
    readonly cachedPromptTokens: number
  }
  /** Provider-reported wall time in milliseconds, when available. */
  readonly wallMs: number
}

/** Why a completion failed. */
export class CompletionError extends Error {
  override readonly name = 'CompletionError'

  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message)
  }
}

/** How the client is configured. */
export interface DeepSeekOptions {
  readonly apiKey: string
  readonly model?: string
  readonly baseUrl?: string
  readonly effort?: Effort
  /**
   * Transport override, so tests need no network and a deployment can add
   * accounting without this module knowing.
   */
  readonly fetch?: typeof fetch
  /** Hard ceiling on output tokens, guarding against a runaway generation. */
  readonly maxTokens?: number
}

/** A minimal DeepSeek chat client. */
export class DeepSeekClient {
  private readonly transport: typeof fetch
  readonly model: string
  readonly effort: Effort
  private readonly baseUrl: string
  private readonly maxTokens: number

  constructor(private readonly options: DeepSeekOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('a DeepSeek API key is required')
    }
    this.transport = options.fetch ?? globalThis.fetch
    if (this.transport === undefined) {
      throw new Error('no fetch implementation available; pass one in options')
    }
    this.model = options.model ?? DEFAULT_MODEL
    this.effort = options.effort ?? 'low'
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.maxTokens = options.maxTokens ?? 4_096
  }

  /**
   * Send one chat completion.
   *
   * `reasoning_effort` is sent as a top-level field. A provider that does not
   * recognise it would reject the request rather than silently ignore it, which is
   * the behaviour a benchmark wants: an unsupported knob must fail loudly, not
   * quietly change what was measured.
   * @param messages - the conversation, oldest first.
   * @param signal - cancellation.
   * @returns the completion and its accounting.
   * @throws {CompletionError} on a transport or provider failure.
   */
  async complete(
    messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const started = Date.now()
    const response = await this.transport(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        stream: false,
        reasoning_effort: this.effort,
      }),
      ...signal === undefined ? {} : { signal },
    })
    const wallMs = Date.now() - started

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new CompletionError(
        response.status,
        detail.slice(0, 500),
        `DeepSeek returned ${response.status}: ${detail.slice(0, 200)}`,
      )
    }

    const body = (await response.json()) as {
      readonly model?: string
      readonly choices?: readonly {
        readonly message?: { readonly content?: string; readonly reasoning_content?: string }
        readonly finish_reason?: string
      }[]
      readonly usage?: {
        readonly prompt_tokens?: number
        readonly completion_tokens?: number
        readonly total_tokens?: number
        readonly prompt_tokens_details?: { readonly cached_tokens?: number }
      }
    }

    // A substituted model would make every downstream number unattributable.
    if (body.model !== undefined && body.model !== this.model) {
      throw new CompletionError(
        200,
        `requested ${this.model}, response named ${body.model}`,
        `the provider answered with a different model than requested`,
      )
    }

    const message = body.choices?.[0]?.message
    return {
      text: message?.content ?? '',
      reasoningText: message?.reasoning_content ?? '',
      model: body.model ?? this.model,
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
        cachedPromptTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      wallMs,
    }
  }
}
