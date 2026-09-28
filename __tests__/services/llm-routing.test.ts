/**
 * Unit Tests: the LLM seam (lib/services/ai/llm.ts)
 *
 *   - each agent is routed to its own vendor, evaluator and critic
 *     independently, with the defaults the competition runs on
 *     (evaluator: Claude Haiku 4.5, critic: gemini-flash-lite);
 *   - model ids resolve per vendor, with the critic falling back to the
 *     evaluator's model of that vendor;
 *   - a truncated or declined Claude reply fails with its own cause instead
 *     of reaching the JSON parser.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  extractClaudeText,
  isTransientLlmError,
  modelIdFor,
  parseJsonObject,
  providerFor,
  withRetry,
} from '@/lib/services/ai/llm'

const ENV_KEYS = [
  'LLM_EVALUATOR_PROVIDER',
  'LLM_CRITIC_PROVIDER',
  'ANTHROPIC_MODEL_ID',
  'ANTHROPIC_CRITIC_MODEL_ID',
  'GEMINI_MODEL_ID',
  'GEMINI_CRITIC_MODEL_ID',
] as const

const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

describe('providerFor', () => {
  // Both default to Anthropic: the Gemini free pool answered 503 for whole
  // hours during setup, and an audit that silently disappears is worse than a
  // slightly less independent one. A billed Gemini key can be opted back in.
  it('defaults both agents to Claude', () => {
    clearEnv()
    expect(providerFor('evaluator')).toBe('anthropic')
    expect(providerFor('critic')).toBe('anthropic')
  })

  it('lets each agent be moved to the other vendor independently', () => {
    clearEnv()
    process.env.LLM_EVALUATOR_PROVIDER = 'google'
    process.env.LLM_CRITIC_PROVIDER = 'anthropic'
    expect(providerFor('evaluator')).toBe('google')
    expect(providerFor('critic')).toBe('anthropic')
  })

  it('accepts the vendors under their model-family names, any casing', () => {
    clearEnv()
    process.env.LLM_EVALUATOR_PROVIDER = 'Claude'
    process.env.LLM_CRITIC_PROVIDER = ' GEMINI '
    expect(providerFor('evaluator')).toBe('anthropic')
    expect(providerFor('critic')).toBe('google')
  })

  it('falls back to the default vendor for an unrecognised value', () => {
    clearEnv()
    process.env.LLM_EVALUATOR_PROVIDER = 'openai'
    expect(providerFor('evaluator')).toBe('anthropic')
  })
})

describe('modelIdFor', () => {
  it('uses the cheapest Claude tier for both agents by default', () => {
    clearEnv()
    expect(modelIdFor('evaluator')).toBe('claude-haiku-4-5')
    expect(modelIdFor('critic')).toBe('claude-haiku-4-5')
  })

  it('still resolves the Gemini model when an agent is put back on Google', () => {
    clearEnv()
    process.env.LLM_CRITIC_PROVIDER = 'google'
    expect(modelIdFor('critic')).toBe('gemini-flash-lite-latest')
  })

  it('resolves the model against the agent vendor, not the other one', () => {
    clearEnv()
    process.env.LLM_CRITIC_PROVIDER = 'google'
    process.env.ANTHROPIC_MODEL_ID = 'claude-sonnet-5'
    process.env.GEMINI_MODEL_ID = 'gemini-flash-latest'
    expect(modelIdFor('evaluator')).toBe('claude-sonnet-5')
    expect(modelIdFor('critic')).toBe('gemini-flash-latest')
  })

  it('gives the critic its own model when one is configured', () => {
    clearEnv()
    process.env.LLM_CRITIC_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_MODEL_ID = 'claude-haiku-4-5'
    process.env.ANTHROPIC_CRITIC_MODEL_ID = 'claude-sonnet-5'
    expect(modelIdFor('evaluator')).toBe('claude-haiku-4-5')
    expect(modelIdFor('critic')).toBe('claude-sonnet-5')
  })

  it('falls the critic back to the evaluator model of the same vendor', () => {
    clearEnv()
    process.env.LLM_CRITIC_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_MODEL_ID = 'claude-haiku-4-5'
    expect(modelIdFor('critic')).toBe('claude-haiku-4-5')
  })
})

describe('extractClaudeText', () => {
  const message = (overrides: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '{"scores":[]}', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...overrides,
    }) as Anthropic.Message

  it('joins every text block of the reply', () => {
    const result = extractClaudeText(
      message({
        content: [
          { type: 'text', text: '{"scores":', citations: null },
          { type: 'text', text: '[]}', citations: null },
        ],
      } as Partial<Anthropic.Message>),
    )
    expect(result).toBe('{"scores":[]}')
    expect(parseJsonObject(result, 'Evaluator')).toEqual({ scores: [] })
  })

  it('ignores non-text blocks such as thinking', () => {
    const result = extractClaudeText(
      message({
        content: [
          { type: 'thinking', thinking: 'weighing the evidence', signature: 'sig' },
          { type: 'text', text: '{"approved":true}', citations: null },
        ],
      } as unknown as Partial<Anthropic.Message>),
    )
    expect(result).toBe('{"approved":true}')
  })

  it('fails with its own cause when the reply was cut off at max_tokens', () => {
    expect(() => extractClaudeText(message({ stop_reason: 'max_tokens' }))).toThrow(
      /cut off at max_tokens/,
    )
  })

  it('fails when the model declined the request', () => {
    expect(() => extractClaudeText(message({ stop_reason: 'refusal' }))).toThrow(/refusal/)
  })
})

describe('isTransientLlmError', () => {
  it('treats vendor overload and rate limits as transient', () => {
    // What Gemini actually answers when flash-lite sheds load.
    expect(
      isTransientLlmError(
        new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] This model is currently experiencing high demand.'),
      ),
    ).toBe(true)
    expect(isTransientLlmError({ status: 429 })).toBe(true)
    expect(isTransientLlmError({ status: 529 })).toBe(true)
    expect(isTransientLlmError(new Error('fetch failed'))).toBe(true)
  })

  it('does not retry a request that will fail the same way every time', () => {
    expect(isTransientLlmError({ status: 400 })).toBe(false)
    expect(isTransientLlmError({ status: 401 })).toBe(false)
    expect(isTransientLlmError(new Error('model not found: claude-typo'))).toBe(false)
  })
})

describe('withRetry', () => {
  const wait = vi.fn().mockResolvedValue(undefined)

  it('retries a transient failure and returns the eventual success', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('[503 Service Unavailable] high demand'))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { wait, attempts: 4 })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially between attempts', async () => {
    wait.mockClear()
    // The delay carries jitter (0.5x-1.5x) so a burst of parallel projects
    // does not retry in lockstep — which also means consecutive delays can
    // overlap. Pinning the random factor to 0.5 (its midpoint multiplier of
    // 1.0) makes the doubling itself observable.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const operation = vi.fn().mockRejectedValue({ status: 503 })

    await expect(withRetry(operation, { wait, attempts: 3, baseDelayMs: 100 })).rejects.toMatchObject({
      status: 503,
    })
    expect(operation).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls.map((c) => c[0] as number)).toEqual([100, 200])
    random.mockRestore()
  })

  it('keeps every jittered delay inside its exponential band', async () => {
    wait.mockClear()
    const operation = vi.fn().mockRejectedValue({ status: 503 })

    await expect(withRetry(operation, { wait, attempts: 4, baseDelayMs: 100 })).rejects.toMatchObject({
      status: 503,
    })
    const delays = wait.mock.calls.map((c) => c[0] as number)
    delays.forEach((delay, i) => {
      const base = 100 * 2 ** i
      expect(delay).toBeGreaterThanOrEqual(base * 0.5)
      expect(delay).toBeLessThanOrEqual(base * 1.5)
    })
  })

  it('gives up immediately on a non-transient failure', async () => {
    const operation = vi.fn().mockRejectedValue({ status: 401, message: 'bad key' })

    await expect(withRetry(operation, { wait, attempts: 4 })).rejects.toMatchObject({ status: 401 })
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
