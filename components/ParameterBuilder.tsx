// components/ParameterBuilder.tsx
// Client component for the dynamic parameter builder.
// Supports add/remove rows, a real-time weight total per track (IDEA / HTML),
// the IDEA-vs-HTML blend and critic settings, batch save, and picking which
// default parameter template to load.
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.3

'use client'

import { useState, useCallback, useTransition } from 'react'
import {
  loadDefaultParametersAction,
  saveParametersAction,
} from '@/actions/parameter.actions'
// The templates come from the neutral module, never from
// `lib/services/category.service.ts`: that service imports `@/lib/db` and
// `@prisma/client` as values, which would follow this client component into
// the browser bundle.
import {
  DEFAULT_PARAMETER_SETS,
  DEFAULT_PARAMETER_SET_LABELS,
  DEFAULT_PARAMETER_SET_ORDER,
  type DefaultParameterSet,
} from '@/lib/default-parameter-sets'
import {
  MAX_CRITIC_ROUNDS_LIMIT,
  SCORING_TRACKS,
  TRACK_LABELS,
  type ScoringTrack,
} from '@/lib/scoring/tracks'

type ScoringMode = 'AUTO' | 'MANUAL'

interface ScoringConfig {
  ideaWeight: number
  htmlWeight: number
  criticEnabled: boolean
  maxCriticRounds: number
}

interface ParameterRow {
  id: string // local ID for key tracking
  name: string
  description: string
  weight: number
  minScore: number
  maxScore: number
  scoringMode: ScoringMode
  track: ScoringTrack
}

interface ParameterBuilderProps {
  categoryId: string
  categoryName: string
  initialParameters: {
    id: string
    name: string
    description: string | null
    weight: number
    minScore: number
    maxScore: number
    scoringMode: string
    track: string
    orderIndex: number
  }[]
  initialScoringConfig: ScoringConfig
  hasExistingScores?: boolean
}

const TRACK_HELP: Record<ScoringTrack, string> = {
  IDEA: 'Scored from the idea document (.md) only — the evaluator never sees the HTML.',
  HTML: 'Scored from the HTML page (URL / Source Code) only — the evaluator never sees the idea document.',
}

const INPUT_CLASS =
  'w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

function generateLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export default function ParameterBuilder({
  categoryId,
  categoryName,
  initialParameters,
  initialScoringConfig,
  hasExistingScores = false,
}: ParameterBuilderProps) {
  const [parameters, setParameters] = useState<ParameterRow[]>(() =>
    initialParameters.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      weight: p.weight,
      minScore: p.minScore,
      maxScore: p.maxScore,
      scoringMode: p.scoringMode as ScoringMode,
      track: p.track === 'IDEA' ? 'IDEA' : 'HTML',
    })),
  )
  const [config, setConfig] = useState<ScoringConfig>(initialScoringConfig)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // Which template the Load button will seed.
  const [selectedSet, setSelectedSet] = useState<DefaultParameterSet>('IDEA_HTML')
  // Set to true once the admin has been warned that loading replaces the
  // category's saved parameters; reset on every other interaction.
  const [awaitingLoadConfirm, setAwaitingLoadConfirm] = useState(false)

  const selectedTemplate = DEFAULT_PARAMETER_SETS[selectedSet]

  // Weight totals are per track: each track's parameters must total 100%.
  const trackTotals = Object.fromEntries(
    SCORING_TRACKS.map((track) => [
      track,
      parameters
        .filter((p) => p.track === track)
        .reduce((sum, p) => sum + p.weight, 0),
    ]),
  ) as Record<ScoringTrack, number>
  const isTrackWeightValid = (track: ScoringTrack) =>
    Math.abs(trackTotals[track] - 100) < 0.001

  const clearMessages = () => {
    setError(null)
    setSuccessMessage(null)
    setAwaitingLoadConfirm(false)
  }

  const updateConfig = (update: Partial<ScoringConfig>) => {
    setConfig((prev) => ({ ...prev, ...update }))
    clearMessages()
  }

  const setIdeaWeight = (value: number) => {
    const ideaWeight = Math.min(100, Math.max(0, value))
    updateConfig({ ideaWeight, htmlWeight: 100 - ideaWeight })
  }

  const addParameter = useCallback((track: ScoringTrack) => {
    setParameters((prev) => [
      ...prev,
      {
        id: generateLocalId(),
        name: '',
        description: '',
        weight: 0,
        minScore: 0,
        maxScore: 100,
        scoringMode: 'AUTO',
        track,
      },
    ])
    setError(null)
    setSuccessMessage(null)
    setAwaitingLoadConfirm(false)
  }, [])

  const removeParameter = useCallback((id: string) => {
    setParameters((prev) => prev.filter((p) => p.id !== id))
    setError(null)
    setSuccessMessage(null)
    setAwaitingLoadConfirm(false)
  }, [])

  const updateParameter = useCallback(
    (id: string, field: keyof ParameterRow, value: string | number) => {
      setParameters((prev) =>
        prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
      )
      setError(null)
      setSuccessMessage(null)
      setAwaitingLoadConfirm(false)
    },
    [],
  )

  // Loading a template REPLACES the category's saved parameters on the
  // server. The check is against `initialParameters` (what the server actually
  // has), not the local draft, so an admin who removed rows without saving
  // still gets warned before their saved parameters are replaced.
  // Requirements: 6.2, 6.3
  const handleLoadDefaults = () => {
    if (initialParameters.length > 0 && !awaitingLoadConfirm) {
      setError(null)
      setSuccessMessage(null)
      setAwaitingLoadConfirm(true)
      return
    }

    setAwaitingLoadConfirm(false)
    startTransition(async () => {
      setError(null)
      setSuccessMessage(null)
      const result = await loadDefaultParametersAction(categoryId, selectedSet)
      if (result.success) {
        window.location.reload()
      } else {
        setError(result.message ?? 'Failed to load defaults')
      }
    })
  }

  const handleSave = () => {
    if (parameters.some((p) => !p.name.trim())) {
      setError('All parameters must have a name')
      return
    }

    // Both files are scored, so both tracks need parameters totalling 100%.
    for (const track of SCORING_TRACKS) {
      const total = trackTotals[track]
      if (!parameters.some((p) => p.track === track)) {
        setError(`Track ${TRACK_LABELS[track]} needs at least one parameter.`)
        return
      }
      if (!isTrackWeightValid(track)) {
        const direction = total < 100 ? 'increase' : 'decrease'
        setError(
          `Total weight of track ${TRACK_LABELS[track]} must equal 100%. Current total is ${total.toFixed(1)}%. Please ${direction} weights by ${Math.abs(100 - total).toFixed(1)}%.`,
        )
        return
      }
    }

    if (Math.abs(config.ideaWeight + config.htmlWeight - 100) > 0.001) {
      setError('Idea weight + HTML weight must equal 100%.')
      return
    }

    const invalidRange = parameters.find((p) => p.maxScore <= p.minScore)
    if (invalidRange) {
      setError(
        `Parameter "${invalidRange.name}": maxScore must be greater than minScore`,
      )
      return
    }

    // Saved in track order so orderIndex groups each track together.
    const ordered = SCORING_TRACKS.flatMap((track) =>
      parameters.filter((p) => p.track === track),
    )

    startTransition(async () => {
      setError(null)
      setSuccessMessage(null)
      const result = await saveParametersAction(
        categoryId,
        ordered.map((p, i) => ({
          // Saved rows keep their id so the server updates them in place (and
          // keeps their scores); rows added in this draft have a local id.
          id: p.id.startsWith('local_') ? null : p.id,
          name: p.name.trim(),
          description: p.description.trim() || null,
          weight: p.weight,
          minScore: p.minScore,
          maxScore: p.maxScore,
          scoringMode: p.scoringMode,
          track: p.track,
          orderIndex: i,
        })),
        config,
      )
      if (result.success) {
        setSuccessMessage('Parameters and scoring weights saved successfully')
      } else {
        setError(result.message ?? 'Failed to save parameters')
      }
    })
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <a href={`/admin/events`} className="text-blue-600 hover:underline text-sm">
          &larr; Back to Events
        </a>
        <h1 className="text-2xl font-bold mt-2">Parameters: {categoryName}</h1>
      </div>

      {hasExistingScores && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
          Warning: This category has existing scores. Modifying parameters may
          affect calculated scores.
        </div>
      )}

      {/* Track blend + critic settings */}
      <div className="mb-6 p-4 bg-white rounded shadow border border-gray-200 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Final Score Weighting</h2>
          <p className="text-xs text-gray-500">
            Final score = Idea score × Idea weight + HTML score × HTML weight.
            Changing the weighting re-blends every submission&apos;s final score
            on save, without calling the AI again.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="text-sm font-medium text-gray-700" htmlFor="idea-weight">
            {TRACK_LABELS.IDEA}
          </label>
          <input
            id="idea-weight"
            type="range"
            min={0}
            max={100}
            step={5}
            value={config.ideaWeight}
            onChange={(e) => setIdeaWeight(Number(e.target.value))}
            className="w-48"
            disabled={isPending}
          />
          <input
            type="number"
            aria-label="Idea weight (%)"
            min={0}
            max={100}
            value={config.ideaWeight}
            onChange={(e) => setIdeaWeight(parseFloat(e.target.value) || 0)}
            className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
            disabled={isPending}
          />
          <span className="text-sm text-gray-700">
            % &nbsp;·&nbsp; {TRACK_LABELS.HTML}: <strong>{config.htmlWeight}%</strong>
          </span>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <h3 className="text-sm font-semibold">Multi-Agent Critic</h3>
          <p className="text-xs text-gray-500 mb-2">
            A second AI agent audits every evaluation: is each score backed by
            the evidence and the parameter&apos;s criterion, or was it lifted by
            presentation, document length or a halo effect? When bias is found,
            the evaluation is redone with the critic&apos;s findings.
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.criticEnabled}
                onChange={(e) => updateConfig({ criticEnabled: e.target.checked })}
                disabled={isPending}
              />
              Enable critic
            </label>
            <label className="flex items-center gap-2 text-sm">
              Max re-evaluations
              <input
                type="number"
                min={0}
                max={MAX_CRITIC_ROUNDS_LIMIT}
                value={config.maxCriticRounds}
                onChange={(e) =>
                  updateConfig({
                    maxCriticRounds: Math.min(
                      MAX_CRITIC_ROUNDS_LIMIT,
                      Math.max(0, parseInt(e.target.value, 10) || 0),
                    ),
                  })
                }
                className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                disabled={isPending || !config.criticEnabled}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        {/* Default template picker — Requirement 6.3 */}
        <div>
          <label
            htmlFor="default-parameter-set"
            className="block text-xs font-medium text-gray-700 mb-1"
          >
            Default template
          </label>
          <select
            id="default-parameter-set"
            value={selectedSet}
            onChange={(e) => {
              setSelectedSet(e.target.value as DefaultParameterSet)
              clearMessages()
            }}
            className="px-3 py-2 border border-gray-300 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isPending}
          >
            {DEFAULT_PARAMETER_SET_ORDER.map((set) => (
              <option key={set} value={set}>
                {DEFAULT_PARAMETER_SET_LABELS[set]}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleLoadDefaults}
          className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 text-sm"
          disabled={isPending}
        >
          {isPending ? 'Loading...' : 'Load Default Template'}
        </button>
        <button
          onClick={handleSave}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
          disabled={isPending || parameters.length === 0}
        >
          {isPending ? 'Saving...' : 'Save Parameters'}
        </button>
      </div>

      {/* What the selected template will seed. Requirement 6.3 */}
      <p className="mb-4 text-xs text-gray-500">
        {DEFAULT_PARAMETER_SET_LABELS[selectedSet]} template:{' '}
        {SCORING_TRACKS.map((track) => {
          const inTrack = selectedTemplate.filter((p) => p.track === track)
          return `${TRACK_LABELS[track]} — ${inTrack.map((p) => `${p.name} (${p.weight}%)`).join(', ')}`
        }).join(' · ')}
      </p>

      {/* Replace-load warning. Requirements: 6.2, 6.3 */}
      {awaitingLoadConfirm && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
          <p>
            This category already has {initialParameters.length} saved
            parameter{initialParameters.length === 1 ? '' : 's'}. Loading the{' '}
            {DEFAULT_PARAMETER_SET_LABELS[selectedSet]} template{' '}
            <strong>replaces</strong> them with its {selectedTemplate.length}{' '}
            parameters — any unsaved edits you have made below are discarded
            too. Parameters with the same name and track are kept in place
            with their scores; the rest are removed along with their AI
            scores. Loading is refused if jury members have already scored a
            parameter that would be removed.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleLoadDefaults}
              className="px-3 py-1.5 bg-yellow-600 text-white rounded hover:bg-yellow-700 text-sm"
              disabled={isPending}
            >
              Replace anyway
            </button>
            <button
              onClick={() => setAwaitingLoadConfirm(false)}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50 text-sm"
              disabled={isPending}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-700 text-sm">
          {successMessage}
        </div>
      )}

      {/* Parameter rows, grouped by track */}
      {SCORING_TRACKS.map((track) => {
        const rows = parameters.filter((p) => p.track === track)
        const total = trackTotals[track]
        const valid = isTrackWeightValid(track)
        return (
          <section key={track} className="mb-8">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">
                Track: {TRACK_LABELS[track]}{' '}
                <span className="text-sm font-normal text-gray-500">
                  ({track === 'IDEA' ? config.ideaWeight : config.htmlWeight}% of final score)
                </span>
              </h2>
              <span
                className={`text-sm font-bold px-2 py-0.5 rounded ${
                  valid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}
              >
                {total.toFixed(1)}%
              </span>
              {!valid && (
                <span className="text-xs text-red-600">
                  {total < 100
                    ? `Need ${(100 - total).toFixed(1)}% more`
                    : `Exceeds by ${(total - 100).toFixed(1)}%`}
                </span>
              )}
              <button
                onClick={() => addParameter(track)}
                className="ml-auto px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                disabled={isPending}
              >
                Add {TRACK_LABELS[track]} Parameter
              </button>
            </div>
            <p className="mb-3 text-xs text-gray-500">{TRACK_HELP[track]}</p>

            {rows.length === 0 ? (
              <p className="text-gray-500 text-sm">
                No parameters in this track. Add parameters or load the default template.
              </p>
            ) : (
              <div className="space-y-4">
                {rows.map((param, index) => (
                  <ParameterCard
                    key={param.id}
                    param={param}
                    label={`${TRACK_LABELS[track]} #${index + 1}`}
                    disabled={isPending}
                    onChange={updateParameter}
                    onRemove={removeParameter}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function ParameterCard({
  param,
  label,
  disabled,
  onChange,
  onRemove,
}: {
  param: ParameterRow
  label: string
  disabled: boolean
  onChange: (id: string, field: keyof ParameterRow, value: string | number) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="p-4 bg-white rounded shadow border border-gray-200">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-500">{label}</span>
        <div className="flex items-center gap-3">
          <select
            aria-label="Track"
            value={param.track}
            onChange={(e) => onChange(param.id, 'track', e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded text-xs bg-white"
            disabled={disabled}
          >
            {SCORING_TRACKS.map((t) => (
              <option key={t} value={t}>
                Track: {TRACK_LABELS[t]}
              </option>
            ))}
          </select>
          <button
            onClick={() => onRemove(param.id)}
            className="text-red-500 hover:text-red-700 text-sm"
            disabled={disabled}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
          <input
            type="text"
            value={param.name}
            onChange={(e) => onChange(param.id, 'name', e.target.value)}
            className={INPUT_CLASS}
            placeholder="Parameter name"
            disabled={disabled}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Weight within track (%)
          </label>
          <input
            type="number"
            value={param.weight}
            onChange={(e) => onChange(param.id, 'weight', parseFloat(e.target.value) || 0)}
            className={INPUT_CLASS}
            min={0}
            max={100}
            step={0.1}
            disabled={disabled}
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description (the criterion the AI evaluator and critic judge against)
          </label>
          <input
            type="text"
            value={param.description}
            onChange={(e) => onChange(param.id, 'description', e.target.value)}
            className={INPUT_CLASS}
            placeholder="Description (optional)"
            disabled={disabled}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Min Score</label>
          <input
            type="number"
            value={param.minScore}
            onChange={(e) => onChange(param.id, 'minScore', parseFloat(e.target.value) || 0)}
            className={INPUT_CLASS}
            min={0}
            disabled={disabled}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Max Score</label>
          <input
            type="number"
            value={param.maxScore}
            onChange={(e) => onChange(param.id, 'maxScore', parseFloat(e.target.value) || 0)}
            className={INPUT_CLASS}
            min={0}
            disabled={disabled}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Scoring Mode</label>
          <div className="flex items-center gap-2">
            {(['AUTO', 'MANUAL'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(param.id, 'scoringMode', mode)}
                className={`px-3 py-1.5 rounded text-sm font-medium ${
                  param.scoringMode === mode
                    ? mode === 'AUTO'
                      ? 'bg-blue-600 text-white'
                      : 'bg-purple-600 text-white'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                }`}
                disabled={disabled}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
