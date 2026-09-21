// components/CriticAuditPanel.tsx
// Server-rendered audit trail of the evaluator ⇄ critic loop for one track:
// each round's scores and the critic's verdict/findings, so an admin or jury
// can see *why* a score was re-evaluated or flagged.

import { TRACK_LABELS, type ScoringTrack } from '@/lib/scoring/tracks'
import type { ParameterEvaluation } from '@/lib/services/ai/evaluator'
import type { CriticVerdict } from '@/lib/services/ai/critic'

export interface EvaluationRunRow {
  id: string
  track: ScoringTrack
  round: number
  evaluation: unknown
  critique: unknown
  approved: boolean
}

interface Props {
  track: ScoringTrack
  runs: EvaluationRunRow[]
  parameterNames: Record<string, string>
  criticEnabled: boolean
}

function asEvaluation(value: unknown): ParameterEvaluation[] {
  return Array.isArray(value) ? (value as ParameterEvaluation[]) : []
}

function asCritique(
  value: unknown,
): (CriticVerdict & { error?: string; oscillationParameterIds?: string[] }) | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<CriticVerdict> & { error?: string; oscillationParameterIds?: string[] }
  return {
    oscillationParameterIds: Array.isArray(v.oscillationParameterIds) ? v.oscillationParameterIds : undefined,
    approved: v.approved === true,
    findings: Array.isArray(v.findings) ? v.findings : [],
    feedback: typeof v.feedback === 'string' ? v.feedback : '',
    error: v.error,
  }
}

export default function CriticAuditPanel({ track, runs, parameterNames, criticEnabled }: Props) {
  const sorted = [...runs].sort((a, b) => a.round - b.round)

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <h3 className="text-sm font-semibold text-gray-900">
        {TRACK_LABELS[track]} — evaluator ⇄ critic
      </h3>
      {sorted.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No AI evaluation for this track yet.</p>
      ) : !criticEnabled && sorted.every((r) => r.critique === null) ? (
        <p className="mt-2 text-sm text-gray-500">
          Critic disabled for this category — evaluated in a single pass.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {sorted.map((run) => {
            const critique = asCritique(run.critique)
            const evaluation = asEvaluation(run.evaluation)
            return (
              <li key={run.id} className="rounded-lg border border-gray-100 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-gray-700">Round {run.round}</span>
                  {critique?.error ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
                      critic unavailable
                    </span>
                  ) : run.approved ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-200">
                      approved by critic
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-200">
                      bias found
                    </span>
                  )}
                  <span className="text-gray-500">
                    {evaluation
                      .map((e) => `${parameterNames[e.parameterId] ?? '?'}: ${e.score}`)
                      .join(' · ')}
                  </span>
                </div>
                {critique?.error && (
                  <p className="mt-2 text-xs text-gray-500">{critique.error}</p>
                )}
                {critique && critique.findings.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-700">
                    {critique.findings.map((f, i) => (
                      <li key={i}>
                        <span className="font-medium">
                          {f.parameterId ? parameterNames[f.parameterId] ?? 'Parameter' : 'Overall'}
                        </span>{' '}
                        <span className="text-amber-700">
                          [{f.biasType}
                          {f.direction ? `, ${f.direction.replace('_', ' ')}` : ''}]
                        </span>{' '}
                        {f.explanation}
                      </li>
                    ))}
                  </ul>
                )}
                {critique?.oscillationParameterIds && critique.oscillationParameterIds.length > 0 && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
                    The critic reversed its own previous finding on{' '}
                    {critique.oscillationParameterIds.map((id) => parameterNames[id] ?? 'a parameter').join(', ')}
                    , so re-evaluation was stopped. This usually means the parameter&apos;s
                    description is ambiguous — rewrite it to say exactly what to judge
                    (e.g. &quot;judge the visible text only, not styling or markup&quot;).
                  </p>
                )}
                {critique?.feedback && (
                  <p className="mt-2 text-xs italic text-gray-500">{critique.feedback}</p>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
