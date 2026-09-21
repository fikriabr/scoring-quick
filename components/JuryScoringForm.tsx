// components/JuryScoringForm.tsx
// Client component for the interactive jury scoring UI.
// Displays per-parameter scoring cards with AI score, reasoning, score input,
// comment field (required when deviation > 20% of range), and action buttons.
// Requirements: 6.2, 6.3, 6.4, 6.5

'use client'

import { useState, useCallback } from 'react'
import { TRACK_LABELS, type ScoringTrack } from '@/lib/scoring/tracks'

interface ParameterData {
  id: string
  name: string
  description: string | null
  weight: number
  minScore: number
  maxScore: number
  aiScore: number | null
  aiReasoning: string | null
  juryScore: number | null
  juryComment: string | null
  track: ScoringTrack
  /** Critic verdict on the AI score: false = still biased after last round. */
  aiCriticApproved: boolean | null
}

interface JuryScoringFormProps {
  projectId: string
  parameters: ParameterData[]
}

interface ParameterState {
  score: string
  comment: string
  submitting: boolean
  accepting: boolean
  error: string | null
  success: string | null
}

export default function JuryScoringForm({
  projectId,
  parameters,
}: JuryScoringFormProps) {
  // Initialize state per parameter
  const [states, setStates] = useState<Record<string, ParameterState>>(() => {
    const initial: Record<string, ParameterState> = {}
    for (const param of parameters) {
      initial[param.id] = {
        score: param.juryScore !== null ? String(param.juryScore) : '',
        comment: param.juryComment ?? '',
        submitting: false,
        accepting: false,
        error: null,
        success: null,
      }
    }
    return initial
  })

  const updateState = useCallback(
    (parameterId: string, update: Partial<ParameterState>) => {
      setStates((prev) => ({
        ...prev,
        [parameterId]: { ...prev[parameterId], ...update },
      }))
    },
    [],
  )

  // Check if comment is required based on deviation threshold
  const isCommentRequired = useCallback(
    (param: ParameterData, scoreValue: number): boolean => {
      if (param.aiScore === null) return false
      const range = param.maxScore - param.minScore
      const threshold = 0.2 * range
      const deviation = Math.abs(scoreValue - param.aiScore)
      return deviation > threshold
    },
    [],
  )

  // Submit jury score for a parameter
  const handleSubmitScore = useCallback(
    async (param: ParameterData) => {
      const state = states[param.id]
      const scoreValue = parseFloat(state.score)

      // Client-side validation
      if (isNaN(scoreValue)) {
        updateState(param.id, { error: 'Enter a valid score', success: null })
        return
      }

      if (scoreValue < param.minScore || scoreValue > param.maxScore) {
        updateState(param.id, {
          error: `Score must be between ${param.minScore} and ${param.maxScore}`,
          success: null,
        })
        return
      }

      // Check comment requirement
      if (isCommentRequired(param, scoreValue) && !state.comment.trim()) {
        updateState(param.id, {
          error:
            'A comment is required because the score differs by more than 20% of the value range compared to the AI Score',
          success: null,
        })
        return
      }

      updateState(param.id, { submitting: true, error: null, success: null })

      try {
        const res = await fetch(`/api/projects/${projectId}/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parameterId: param.id,
            score: scoreValue,
            comment: state.comment.trim() || null,
          }),
        })

        if (!res.ok) {
          const data = await res.json()
          if (res.status === 403) {
            updateState(param.id, {
              error: 'You do not have access to score this project',
              submitting: false,
            })
          } else if (res.status === 400) {
            updateState(param.id, {
              error: data.message || 'Validation error',
              submitting: false,
            })
          } else {
            updateState(param.id, {
              error: data.message || 'An error occurred',
              submitting: false,
            })
          }
          return
        }

        updateState(param.id, {
          submitting: false,
          success: 'Score saved successfully',
          error: null,
        })
      } catch {
        updateState(param.id, {
          error: 'Failed to submit score. Please try again.',
          submitting: false,
        })
      }
    },
    [states, projectId, updateState, isCommentRequired],
  )

  // Accept AI score for a parameter
  const handleAcceptAiScore = useCallback(
    async (param: ParameterData) => {
      updateState(param.id, { accepting: true, error: null, success: null })

      try {
        const res = await fetch(`/api/projects/${projectId}/score/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parameterId: param.id }),
        })

        if (!res.ok) {
          const data = await res.json()
          if (res.status === 403) {
            updateState(param.id, {
              error: 'You do not have access to score this project',
              accepting: false,
            })
          } else if (res.status === 400) {
            updateState(param.id, {
              error: data.message || 'Validation error',
              accepting: false,
            })
          } else {
            updateState(param.id, {
              error: data.message || 'An error occurred',
              accepting: false,
            })
          }
          return
        }

        // Update local state to reflect accepted score
        updateState(param.id, {
          accepting: false,
          success: 'AI Score accepted',
          error: null,
          score: param.aiScore !== null ? String(param.aiScore) : '',
          comment: '',
        })
      } catch {
        updateState(param.id, {
          error: 'Failed to accept AI score. Please try again.',
          accepting: false,
        })
      }
    },
    [projectId, updateState],
  )

  if (parameters.length === 0) {
    return (
      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
        No scoring parameters have been configured for this category yet.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Scoring Per Parameter</h2>

      {parameters.map((param, index) => {
        const state = states[param.id]
        const startsTrack = index === 0 || parameters[index - 1].track !== param.track
        const scoreValue = parseFloat(state.score)
        const showComment =
          !isNaN(scoreValue) && isCommentRequired(param, scoreValue)

        return (
          <div key={param.id} className="space-y-3">
          {startsTrack && (
            <h3 className="pt-2 text-base font-semibold text-gray-800 border-b border-gray-200 pb-1">
              Track: {TRACK_LABELS[param.track]}
            </h3>
          )}
          <div className="p-4 bg-white rounded shadow border border-gray-200">
            {/* Parameter header */}
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-semibold text-gray-900">
                  {param.name}
                </h3>
                {param.description && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    {param.description}
                  </p>
                )}
              </div>
              <span className="text-sm font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded">
                Weight: {param.weight}%
              </span>
            </div>

            {/* AI Score section */}
            {param.aiScore !== null ? (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-blue-800">
                    AI Score:
                  </span>
                  <span className="text-lg font-bold text-blue-900">
                    {param.aiScore}
                  </span>
                  <span className="text-xs text-blue-600">
                    (range: {param.minScore} — {param.maxScore})
                  </span>
                </div>
                {param.aiReasoning && (
                  <p className="text-sm text-blue-700 mt-1 whitespace-pre-line">
                    {param.aiReasoning}
                  </p>
                )}
                {param.aiCriticApproved === false && (
                  <p className="mt-2 text-xs font-medium text-amber-700">
                    The critic agent still found bias in this AI score after the
                    last re-evaluation — please review it carefully.
                  </p>
                )}
              </div>
            ) : (
              <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded">
                <p className="text-sm text-gray-500 italic">
                  No AI Score for this parameter yet.
                </p>
              </div>
            )}

            {/* Existing jury score indicator */}
            {param.juryScore !== null && (
              <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-100 rounded px-3 py-2">
                Previous jury score:{' '}
                <span className="font-semibold">{param.juryScore}</span>
                {param.juryComment && (
                  <span className="ml-2 text-gray-600">
                    — &ldquo;{param.juryComment}&rdquo;
                  </span>
                )}
              </div>
            )}

            {/* Score input */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor={`score-${param.id}`}
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Your Score ({param.minScore} — {param.maxScore})
                </label>
                <input
                  id={`score-${param.id}`}
                  type="number"
                  value={state.score}
                  onChange={(e) =>
                    updateState(param.id, {
                      score: e.target.value,
                      error: null,
                      success: null,
                    })
                  }
                  min={param.minScore}
                  max={param.maxScore}
                  step={0.1}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder={`${param.minScore} — ${param.maxScore}`}
                  disabled={state.submitting || state.accepting}
                />
              </div>

              {/* Comment field — visible when deviation > 20% of range */}
              {showComment && (
                <div className="md:col-span-2">
                  <label
                    htmlFor={`comment-${param.id}`}
                    className="block text-sm font-medium text-red-700 mb-1"
                  >
                    Comment (required — score differs &gt;20% from AI Score)
                  </label>
                  <textarea
                    id={`comment-${param.id}`}
                    value={state.comment}
                    onChange={(e) =>
                      updateState(param.id, {
                        comment: e.target.value,
                        error: null,
                        success: null,
                      })
                    }
                    rows={2}
                    className="w-full px-3 py-2 border border-red-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                    placeholder="Explain the reason for the score difference..."
                    disabled={state.submitting || state.accepting}
                  />
                </div>
              )}

              {/* Optional comment when NOT required */}
              {!showComment && (
                <div>
                  <label
                    htmlFor={`comment-opt-${param.id}`}
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Comment (optional)
                  </label>
                  <input
                    id={`comment-opt-${param.id}`}
                    type="text"
                    value={state.comment}
                    onChange={(e) =>
                      updateState(param.id, {
                        comment: e.target.value,
                        error: null,
                        success: null,
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Comment (optional)"
                    disabled={state.submitting || state.accepting}
                  />
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => handleSubmitScore(param)}
                disabled={state.submitting || state.accepting || !state.score}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.submitting ? 'Saving...' : 'Submit Score'}
              </button>

              {param.aiScore !== null && (
                <button
                  onClick={() => handleAcceptAiScore(param)}
                  disabled={state.submitting || state.accepting}
                  className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {state.accepting ? 'Accepting...' : 'Accept AI Score'}
                </button>
              )}
            </div>

            {/* Error / Success messages */}
            {state.error && (
              <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {state.error}
              </div>
            )}
            {state.success && (
              <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-green-700 text-sm">
                {state.success}
              </div>
            )}
          </div>
          </div>
        )
      })}
    </div>
  )
}
