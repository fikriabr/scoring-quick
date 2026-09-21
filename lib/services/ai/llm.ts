// lib/services/ai/llm.ts
// Thin LLM seam for the scoring agents.
//
// The evaluator and critic only need "prompt in, JSON text out". Keeping that
// behind an interface lets the multi-agent loop be unit-tested with a scripted
// fake, and lets the critic run on a different model than the evaluator (a
// second opinion from the same model shares the same blind spots).

import { GoogleGenerativeAI } from '@google/generative-ai'

export type AgentRole = 'evaluator' | 'critic'

export interface LlmClient {
  /** Returns the raw text of the model's reply (expected to be JSON). */
  generate(prompt: string, role: AgentRole): Promise<string>
}

const DEFAULT_MODEL_ID = 'gemini-flash-lite-latest'

/** Model used by each agent. The critic falls back to the evaluator's model. */
export function modelIdFor(role: AgentRole): string {
  const evaluatorModel = process.env.GEMINI_MODEL_ID ?? DEFAULT_MODEL_ID
  if (role === 'critic') return process.env.GEMINI_CRITIC_MODEL_ID ?? evaluatorModel
  return evaluatorModel
}

export function createGeminiClient(
  apiKey: string = process.env.GEMINI_API_KEY ?? '',
): LlmClient {
  const genAI = new GoogleGenerativeAI(apiKey)

  return {
    async generate(prompt, role) {
      const model = genAI.getGenerativeModel({
        model: modelIdFor(role),
        // Judging is not a creative task: the same evidence should produce the
        // same verdict on every run. Temperature 0 removes sampling swings;
        // JSON mode removes most of the "prose around the JSON" failures.
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      })
      const result = await model.generateContent(prompt)
      return result.response.text()
    },
  }
}

/**
 * Parse a JSON object out of a model reply, tolerating markdown code fences
 * and stray prose around the object.
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
