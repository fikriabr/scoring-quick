/**
 * Unit Tests: evaluator ⇄ critic loop (lib/services/ai/pipeline.ts)
 *
 *   - an approved first round costs exactly one evaluator + one critic call;
 *   - a rejection sends the critic's findings back to the evaluator;
 *   - the loop stops after `maxCriticRounds` re-evaluations and flags the
 *     result (approved = false) instead of looping forever;
 *   - a broken critic never throws away a valid evaluation;
 *   - the critic's verdict is only "approved" when it lists no findings.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AgentRole, LlmClient } from '@/lib/services/ai/llm'
import { findReversals, runTrackEvaluation } from '@/lib/services/ai/pipeline'
import { extractVisibleText } from '@/lib/services/ai/evidence'
import { buildCriticPrompt, parseCriticResponse } from '@/lib/services/ai/critic'
import { buildEvaluatorPrompt, type EvaluatedParameter } from '@/lib/services/ai/evaluator'
import type { TrackEvidence } from '@/lib/services/ai/evidence'

const PARAMS: EvaluatedParameter[] = [
  { id: 'p-problem', name: 'Problem', description: 'Real problem?', minScore: 0, maxScore: 100 },
  { id: 'p-novelty', name: 'Novelty', description: 'Novel solution?', minScore: 0, maxScore: 100 },
]

const IDEA: TrackEvidence = { track: 'IDEA', ideaDoc: '# Idea\nOffline POS for small shops.' }

const evaluation = (a: number, b: number) =>
  JSON.stringify({
    scores: [
      { parameter: 'P1', score: a, evidence: 'q1', reasoning: 'r1' },
      { parameter: 'P2', score: b, evidence: 'q2', reasoning: 'r2' },
    ],
  })

const APPROVE = JSON.stringify({ approved: true, findings: [], feedback: 'ok' })
const REJECT = JSON.stringify({
  approved: false,
  findings: [
    {
      parameter: 'P2',
      biasType: 'LENGTH_BIAS',
      direction: 'too_high',
      explanation: 'Rewarded a long feature list, not novelty.',
    },
  ],
  feedback: 'Novelty is inflated by document length.',
})

/** A fake model that answers each role from its own script, in order. */
function scriptedLlm(script: Record<AgentRole, (string | Error)[]>) {
  const calls: { role: AgentRole; prompt: string }[] = []
  const queues = { evaluator: [...script.evaluator], critic: [...script.critic] }
  const llm: LlmClient = {
    generate: vi.fn(async (prompt: string, role: AgentRole) => {
      calls.push({ role, prompt })
      const next = queues[role].shift()
      if (next === undefined) throw new Error(`unexpected ${role} call`)
      if (next instanceof Error) throw next
      return next
    }),
  }
  return { llm, calls }
}

describe('runTrackEvaluation', () => {
  it('approved on the first round: one evaluator call, one critic call', async () => {
    const { llm, calls } = scriptedLlm({ evaluator: [evaluation(70, 60)], critic: [APPROVE] })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 2,
    })

    expect(calls.map((c) => c.role)).toEqual(['evaluator', 'critic'])
    expect(result.approved).toBe(true)
    expect(result.scores.map((s) => s.score)).toEqual([70, 60])
    expect(result.rounds).toHaveLength(1)
  })

  it('re-evaluates with the critic findings after a rejection, keeping the corrected scores', async () => {
    const { llm, calls } = scriptedLlm({
      evaluator: [evaluation(70, 95), evaluation(70, 55)],
      critic: [REJECT, APPROVE],
    })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 2,
    })

    expect(calls.map((c) => c.role)).toEqual(['evaluator', 'critic', 'evaluator', 'critic'])
    const retryPrompt = calls[2].prompt
    expect(retryPrompt).toContain('Your Previous Evaluation (rejected by the auditor)')
    expect(retryPrompt).toContain('LENGTH_BIAS')
    expect(retryPrompt).toContain('Rewarded a long feature list, not novelty.')
    expect(retryPrompt).toContain('- P2: 95')

    expect(result.approved).toBe(true)
    expect(result.scores.map((s) => s.score)).toEqual([70, 55])
    expect(result.rounds.map((r) => r.approved)).toEqual([false, true])
  })

  it('stops after maxCriticRounds re-evaluations and flags the result for review', async () => {
    const { llm, calls } = scriptedLlm({
      evaluator: [evaluation(90, 90), evaluation(88, 88), evaluation(85, 85)],
      critic: [REJECT, REJECT, REJECT],
    })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 2,
    })

    // 1 initial evaluation + 2 re-evaluations, each audited.
    expect(calls.filter((c) => c.role === 'evaluator')).toHaveLength(3)
    expect(calls.filter((c) => c.role === 'critic')).toHaveLength(3)
    expect(result.approved).toBe(false)
    expect(result.scores.map((s) => s.score)).toEqual([85, 85])
  })

  it('maxCriticRounds = 0 audits once and never re-evaluates', async () => {
    const { llm, calls } = scriptedLlm({ evaluator: [evaluation(90, 90)], critic: [REJECT] })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 0,
    })

    expect(calls).toHaveLength(2)
    expect(result.approved).toBe(false)
  })

  it('with the critic disabled: a single evaluator call, result not audited', async () => {
    const { llm, calls } = scriptedLlm({ evaluator: [evaluation(70, 60)], critic: [] })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: false, maxCriticRounds: 2,
    })

    expect(calls.map((c) => c.role)).toEqual(['evaluator'])
    expect(result.approved).toBeNull()
  })

  it('keeps the evaluation, un-audited, when the critic call fails', async () => {
    const { llm } = scriptedLlm({
      evaluator: [evaluation(70, 60)],
      critic: [new Error('critic quota exceeded')],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 2,
    })

    expect(result.approved).toBeNull()
    expect(result.scores.map((s) => s.score)).toEqual([70, 60])
    expect(result.rounds[0].criticError).toContain('critic quota exceeded')
  })

  it('propagates an evaluator failure — there is nothing to keep', async () => {
    const { llm } = scriptedLlm({ evaluator: [new Error('model down')], critic: [] })
    await expect(
      runTrackEvaluation({ evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 2 }),
    ).rejects.toThrow('model down')
  })
})

describe('parseCriticResponse', () => {
  it('maps parameter keys to ids and normalises unknown bias types to OTHER', () => {
    const verdict = parseCriticResponse(
      JSON.stringify({
        approved: false,
        findings: [
          { parameter: 'P1', biasType: 'halo_effect', direction: 'too_high', explanation: 'x' },
          { parameter: null, biasType: 'VIBES', direction: 'sideways', explanation: 'y' },
        ],
        feedback: 'fix',
      }),
      PARAMS,
    )
    expect(verdict.findings).toEqual([
      { parameterId: 'p-problem', biasType: 'HALO_EFFECT', direction: 'too_high', explanation: 'x' },
      { parameterId: null, biasType: 'OTHER', direction: null, explanation: 'y' },
    ])
  })

  it('is not approved when it claims approval but still lists findings', () => {
    const verdict = parseCriticResponse(
      JSON.stringify({
        approved: true,
        findings: [{ parameter: 'P1', biasType: 'LENGTH_BIAS', explanation: 'padding' }],
      }),
      PARAMS,
    )
    expect(verdict.approved).toBe(false)
  })

  it('drops findings with no explanation', () => {
    const verdict = parseCriticResponse(
      JSON.stringify({ approved: true, findings: [{ parameter: 'P1', biasType: 'OTHER' }] }),
      PARAMS,
    )
    expect(verdict).toMatchObject({ approved: true, findings: [] })
  })
})

describe('prompts — isolation and anti-bias instructions', () => {
  const HTML: TrackEvidence = {
    track: 'HTML',
    url: 'https://example.com',
    sourceCode: '<html><body><main>Shiny</main></body></html>',
    structure: null,
  }

  it('the IDEA evaluator is told to ignore length and formatting, and sees no HTML block', () => {
    const prompt = buildEvaluatorPrompt(IDEA, PARAMS)
    expect(prompt).toContain('Document length')
    expect(prompt).toContain('<<<IDEA_DOCUMENT')
    expect(prompt).not.toContain('<<<HTML_SOURCE')
  })

  it('the HTML evaluator is told the idea is judged separately, and sees no idea document', () => {
    const prompt = buildEvaluatorPrompt(HTML, PARAMS)
    expect(prompt).toContain('judged separately from the idea document')
    expect(prompt).toContain('<<<HTML_SOURCE')
    expect(prompt).not.toContain('<<<IDEA_DOCUMENT')
  })

  it('the HTML critic asks whether scores were lifted by looks or by the idea', () => {
    const prompt = buildCriticPrompt(HTML, PARAMS, [
      { parameterId: 'p-problem', score: 90, evidence: 'e', reasoning: 'r' },
      { parameterId: 'p-novelty', score: 90, evidence: 'e', reasoning: 'r' },
    ])
    expect(prompt).toContain('looks attractive')
    expect(prompt).toContain('idea/topic of the page sounds good')
    expect(prompt).toContain('- P1: score 90')
  })
})

describe('oscillation guard — the critic contradicting itself', () => {
  const finding = (direction: 'too_high' | 'too_low') =>
    JSON.stringify({
      approved: false,
      findings: [
        { parameter: 'P2', biasType: 'OFF_PARAMETER', direction, explanation: `looks ${direction}` },
      ],
      feedback: 'fix P2',
    })

  it('stops re-evaluating when a finding flips direction, and flags the result', async () => {
    const { llm, calls } = scriptedLlm({
      evaluator: [evaluation(85, 85), evaluation(85, 50), evaluation(85, 85)],
      critic: [finding('too_high'), finding('too_low'), finding('too_high')],
    })

    const result = await runTrackEvaluation({
      evidence: IDEA, parameters: PARAMS, llm, criticEnabled: true, maxCriticRounds: 5,
    })

    // Round 2's critique reverses round 1's → stop after round 2.
    expect(calls.filter((c) => c.role === 'evaluator')).toHaveLength(2)
    expect(result.approved).toBe(false)
    expect(result.rounds[1].oscillation).toEqual({ parameterIds: ['p-novelty'] })
  })

  it('findReversals ignores repeated findings in the same direction', () => {
    const high = parseCriticResponse(finding('too_high'), PARAMS)
    const low = parseCriticResponse(finding('too_low'), PARAMS)
    expect(findReversals(high, high)).toEqual([])
    expect(findReversals(null, low)).toEqual([])
    expect(findReversals(high, low)).toEqual(['p-novelty'])
  })
})

describe('HTML evidence — visible text and evidence routing', () => {
  const html = `<html><head><title>T</title><style>h1{font-size:40px;line-height:1.2}</style></head>
<body><h1>Welcome</h1><p>We help   small shops.</p><script>track()</script></body></html>`

  it('extracts what a visitor reads, without CSS or scripts', () => {
    const text = extractVisibleText(html)
    expect(text).toContain('Welcome')
    expect(text).toContain('We help small shops.')
    expect(text).not.toContain('font-size')
    expect(text).not.toContain('track()')
  })

  it('HTML prompts carry a Visible Text block and route content parameters to it', () => {
    const evidence: TrackEvidence = { track: 'HTML', url: null, sourceCode: html, structure: null }
    const evaluatorPrompt = buildEvaluatorPrompt(evidence, PARAMS)
    expect(evaluatorPrompt).toContain('<<<VISIBLE_TEXT')
    expect(evaluatorPrompt).toContain('clarity or tone are judged from the Visible Text')
    expect(evaluatorPrompt).not.toContain('primary evidence')

    const criticPrompt = buildCriticPrompt(evidence, PARAMS, [
      { parameterId: 'p-problem', score: 80, evidence: 'e', reasoning: 'r' },
      { parameterId: 'p-novelty', score: 80, evidence: 'e', reasoning: 'r' },
    ])
    expect(criticPrompt).toContain("Judge OFF_PARAMETER against each parameter's own criterion")
    expect(criticPrompt).toContain('clarity or tone are judged from the Visible Text')
  })

  it('the IDEA prompt does not get the HTML routing rule', () => {
    expect(buildEvaluatorPrompt(IDEA, PARAMS)).not.toContain('Visible Text')
  })
})
