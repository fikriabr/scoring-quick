// lib/services/ai/llm.ts
// Thin LLM seam for the scoring agents.
//
// The evaluator and critic only need "prompt in, JSON text out". Keeping that
// behind an interface lets the multi-agent loop be unit-tested with a scripted
// fake, and lets each agent run on its own model — from a different vendor.
//
// Default wiring: both agents on Anthropic Claude Haiku 4.5 — the cheapest
// Claude tier, which is what makes a 3000-project run affordable.
//
// Two different vendors would be the stronger setup (an auditor that shares
// the evaluator's training tends to approve the same mistakes), and this seam
// supports it per agent. The Gemini free tier proved too unreliable to judge a
// competition on — whole hours of `503 UNAVAILABLE` across every flash model —
// so the default is the vendor that answers. Set `LLM_CRITIC_PROVIDER=google`
// to put the audit back on a (billed) Gemini key.

import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

export type AgentRole = 'evaluator' | 'critic'

export type LlmProvider = 'anthropic' | 'google'

export interface LlmClient {
  /** Returns the raw text of the model's reply (expected to be JSON). */
  generate(prompt: string, role: AgentRole): Promise<string>
}

const DEFAULT_GEMINI_MODEL_ID = 'gemini-flash-lite-latest'
const DEFAULT_ANTHROPIC_MODEL_ID = 'claude-haiku-4-5'

/** Enough for a few hundred words of JSON per parameter; nowhere near the cap. */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8000

/**
 * Models that still accept sampling parameters. `temperature: 0` makes the
 * same evidence produce the same verdict, which matters for a competition —
 * but it is rejected with a 400 on the current Claude models (Opus 5,
 * Sonnet 5, Fable, the 4.6+ family), where thinking replaced it. Sending it
 * only where it is supported keeps this client usable on any model id.
 */
const ANTHROPIC_SAMPLING_SUPPORTED = /^claude-(haiku-4-5|3-)/

function envProvider(name: string): LlmProvider | undefined {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === 'anthropic' || value === 'claude') return 'anthropic'
  if (value === 'google' || value === 'gemini') return 'google'
  return undefined
}

/** Which vendor serves each agent. */
export function providerFor(role: AgentRole): LlmProvider {
  if (role === 'critic') return envProvider('LLM_CRITIC_PROVIDER') ?? 'anthropic'
  return envProvider('LLM_EVALUATOR_PROVIDER') ?? 'anthropic'
}

/** Model used by each agent, resolved against that agent's provider. */
export function modelIdFor(role: AgentRole, provider: LlmProvider = providerFor(role)): string {
  if (provider === 'anthropic') {
    const evaluatorModel = process.env.ANTHROPIC_MODEL_ID ?? DEFAULT_ANTHROPIC_MODEL_ID
    return role === 'critic'
      ? process.env.ANTHROPIC_CRITIC_MODEL_ID ?? evaluatorModel
      : evaluatorModel
  }
  const evaluatorModel = process.env.GEMINI_MODEL_ID ?? DEFAULT_GEMINI_MODEL_ID
  return role === 'critic'
    ? process.env.GEMINI_CRITIC_MODEL_ID ?? evaluatorModel
    : evaluatorModel
}

// -----------------------------------------------------------------------
// Transient failures
//
// A judging run is thousands of calls long, and both vendors shed load: the
// Gemini models answer 503 "experiencing high demand" in bursts, and either
// vendor can answer 429. The Anthropic SDK already retries 429/5xx twice on
// its own; the Google SDK does not retry at all, so the wrapper below gives
// both the same floor. Without it a single 503 silently costs a project its
// audit (the pipeline keeps the evaluation and marks it un-audited).
// -----------------------------------------------------------------------

const DEFAULT_RETRY_ATTEMPTS = 4
const DEFAULT_RETRY_BASE_DELAY_MS = 1000

/** Codes and phrases both vendors use for "busy, try again". */
const TRANSIENT_PATTERN =
  /(429|500|502|503|504)|too many requests|rate.?limit|overloaded|high demand|unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed/i

export function isTransientLlmError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number') return status === 429 || status >= 500
  return TRANSIENT_PATTERN.test(error instanceof Error ? error.message : String(error))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retries a call while it keeps failing transiently, backing off exponentially
 * with jitter. A non-transient failure (bad request, bad key, unknown model)
 * is rethrown immediately — retrying it would only waste the run's time.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number
    baseDelayMs?: number
    label?: string
    wait?: (ms: number) => Promise<void>
  } = {},
): Promise<T> {
  const attempts =
    options.attempts ?? (Number(process.env.LLM_MAX_RETRIES) || DEFAULT_RETRY_ATTEMPTS)
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const wait = options.wait ?? sleep

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isTransientLlmError(error)) throw error
      // Jitter so a burst of parallel projects does not retry in lockstep.
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random())
      console.warn(
        `[LLM] ${options.label ?? 'call'} failed transiently (attempt ${attempt}/${attempts}), retrying in ${Math.round(delay)}ms:`,
        error instanceof Error ? error.message : error,
      )
      await wait(delay)
    }
  }
  throw lastError
}

// -----------------------------------------------------------------------
// Response parsing
// -----------------------------------------------------------------------

/**
 * Parse a JSON object out of a model reply, tolerating markdown code fences
 * and stray prose around the object. Vendor-neutral on purpose: it is what
 * lets the agents run on a model without a structured-output schema.
 */
export function parseJsonObject(rawText: string, source: string): Record<string, unknown> {
  const text = (rawText ?? '').trim()
  if (!text) throw new Error(`Empty response from ${source}`)

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  const candidates = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`${source} response is not a valid JSON object: ${unfenced.slice(0, 200)}`)
}

// -----------------------------------------------------------------------
// Google Gemini
// -----------------------------------------------------------------------

export function createGeminiClient(
  apiKey: string = process.env.GEMINI_API_KEY ?? '',
): LlmClient {
  const genAI = new GoogleGenerativeAI(apiKey)

  return {
    async generate(prompt, role) {
      const model = genAI.getGenerativeModel({
        model: modelIdFor(role, 'google'),
        // Judging is not a creative task: the same evidence should produce the
        // same verdict on every run. Temperature 0 removes sampling swings;
        // JSON mode removes most of the "prose around the JSON" failures.
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      })
      const result = await withRetry(() => model.generateContent(prompt), {
        label: `gemini ${role}`,
      })
      return result.response.text()
    },
  }
}

// -----------------------------------------------------------------------
// Anthropic Claude
// -----------------------------------------------------------------------

/**
 * Concatenates the text blocks of a Claude response.
 *
 * `content` is a list of blocks, not a string, and a reply can carry more than
 * one text block. A truncated or declined reply is turned into an error here
 * rather than handed to the JSON parser, so the failure names its own cause
 * ("hit max_tokens") instead of surfacing as "not a valid JSON object".
 */
export function extractClaudeText(message: Anthropic.Message): string {
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer this request (stop_reason: refusal)')
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')

  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `Claude reply was cut off at max_tokens (${message.usage.output_tokens} output tokens) — raise ANTHROPIC_MAX_TOKENS`,
    )
  }
  return text
}

export function createClaudeClient(
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
): LlmClient {
  // No apiKey passed and none in the env still constructs: the SDK also reads
  // an `ant auth login` profile. Let it decide rather than failing here.
  const client = new Anthropic(apiKey ? { apiKey } : {})
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS) || DEFAULT_ANTHROPIC_MAX_TOKENS

  return {
    async generate(prompt, role) {
      const model = modelIdFor(role, 'anthropic')
      const message = await withRetry(
        () =>
          client.messages.create({
            model,
            max_tokens: maxTokens,
            ...(ANTHROPIC_SAMPLING_SUPPORTED.test(model) ? { temperature: 0 } : {}),
            // The agents' own prompts already demand a bare JSON object, and
            // `parseJsonObject` tolerates fences and stray prose, so no
            // structured output schema is attached here — it would have to
            // differ per agent and would tie this seam to one vendor's format.
            messages: [{ role: 'user', content: prompt }],
          }),
        { label: `claude ${role}` },
      )
      return extractClaudeText(message)
    },
  }
}

// -----------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------

/**
 * One `LlmClient` that sends each agent to its configured vendor. Clients are
 * created once and reused; a vendor that no agent uses is never constructed,
 * so a missing API key for it is not an error.
 */
export function createRoutedLlmClient(): LlmClient {
  const clients: Partial<Record<LlmProvider, LlmClient>> = {}

  const clientFor = (provider: LlmProvider): LlmClient => {
    clients[provider] ??= provider === 'anthropic' ? createClaudeClient() : createGeminiClient()
    return clients[provider]
  }

  return {
    generate(prompt, role) {
      return clientFor(providerFor(role)).generate(prompt, role)
    },
  }
}
