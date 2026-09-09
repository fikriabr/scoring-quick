// components/ParameterBuilder.tsx
// Client component for dynamic parameter builder.
// Supports add/remove rows, real-time weight total, batch save, and picking
// which default parameter template to load.
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

type ScoringMode = 'AUTO' | 'MANUAL'

interface ParameterRow {
  id: string // local ID for key tracking
  name: string
  description: string
  weight: number
  minScore: number
  maxScore: number
  scoringMode: ScoringMode
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
    orderIndex: number
  }[]
  hasExistingScores?: boolean
}

function generateLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export default function ParameterBuilder({
  categoryId,
  categoryName,
  initialParameters,
  hasExistingScores = false,
}: ParameterBuilderProps) {
  const [parameters, setParameters] = useState<ParameterRow[]>(() =>
    initialParameters.length > 0
      ? initialParameters.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? '',
          weight: p.weight,
          minScore: p.minScore,
          maxScore: p.maxScore,
          scoringMode: p.scoringMode as ScoringMode,
        }))
      : [],
  )
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // Which template the Load button will seed.
  const [selectedSet, setSelectedSet] =
    useState<DefaultParameterSet>('HTML')
  // Set to true once the admin has been warned that loading appends rows to a
  // category that already has parameters; reset on every other interaction.
  const [awaitingLoadConfirm, setAwaitingLoadConfirm] = useState(false)

  const selectedTemplate = DEFAULT_PARAMETER_SETS[selectedSet]

  // Calculate total weight
  const totalWeight = parameters.reduce((sum, p) => sum + p.weight, 0)
  const isWeightValid = Math.abs(totalWeight - 100) < 0.001

  const addParameter = useCallback(() => {
    setParameters((prev) => [
      ...prev,
      {
        id: generateLocalId(),
        name: '',
        description: '',
        weight: 0,
        minScore: 0,
        maxScore: 100,
        scoringMode: 'AUTO' as ScoringMode,
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

  // Seeding is additive on the server (`createMany` with `skipDuplicates`), so
  // loading a template into a category that already has parameters appends rows
  // and can push the weight total well past 100%. Warn first, load on the
  // second click. Requirements: 6.2, 6.3
  const handleLoadDefaults = () => {
    if (parameters.length > 0 && !awaitingLoadConfirm) {
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
        // Reload the page to get fresh data from server
        window.location.reload()
      } else {
        setError(result.message ?? 'Failed to load defaults')
      }
    })
  }

  const handleSave = () => {
    // Client-side validation
    if (parameters.length === 0) {
      setError('At least one parameter is required')
      return
    }

    // Check all names are non-empty
    const emptyName = parameters.find((p) => !p.name.trim())
    if (emptyName) {
      setError('All parameters must have a name')
      return
    }

    // Check weight total
    if (!isWeightValid) {
      const diff = (100 - totalWeight).toFixed(1)
      const direction = totalWeight < 100 ? 'increase' : 'decrease'
      setError(
        `Total weight must equal 100%. Current total is ${totalWeight.toFixed(1)}%. Please ${direction} weights by ${Math.abs(Number(diff)).toFixed(1)}%.`,
      )
      return
    }

    // Check minScore < maxScore
    const invalidRange = parameters.find((p) => p.maxScore <= p.minScore)
    if (invalidRange) {
      setError(
        `Parameter "${invalidRange.name}": maxScore must be greater than minScore`,
      )
      return
    }

    startTransition(async () => {
      setError(null)
      setSuccessMessage(null)
      const result = await saveParametersAction(
        categoryId,
        parameters.map((p, i) => ({
          name: p.name.trim(),
          description: p.description.trim() || null,
          weight: p.weight,
          minScore: p.minScore,
          maxScore: p.maxScore,
          scoringMode: p.scoringMode,
          orderIndex: i,
        })),
      )
      if (result.success) {
        setSuccessMessage('Parameters saved successfully')
      } else {
        setError(result.message ?? 'Failed to save parameters')
      }
    })
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <a
          href={`/admin/events`}
          className="text-blue-600 hover:underline text-sm"
        >
          &larr; Back to Events
        </a>
        <h1 className="text-2xl font-bold mt-2">Parameters: {categoryName}</h1>
      </div>

      {/* Warning for existing scores */}
      {hasExistingScores && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
          Warning: This category has existing scores. Modifying parameters may
          affect calculated scores.
        </div>
      )}

      {/* Weight total indicator */}
      <div className="mb-4 flex items-center gap-3">
        <span className="font-medium">Total Weight:</span>
        <span
          className={`text-lg font-bold px-3 py-1 rounded ${
            isWeightValid
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-700'
          }`}
        >
          {totalWeight.toFixed(1)}%
        </span>
        {!isWeightValid && (
          <span className="text-sm text-red-600">
            {totalWeight < 100
              ? `Need ${(100 - totalWeight).toFixed(1)}% more`
              : `Exceeds by ${(totalWeight - 100).toFixed(1)}%`}
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <button
          onClick={addParameter}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          disabled={isPending}
        >
          Add Parameter
        </button>

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
              setError(null)
              setSuccessMessage(null)
              setAwaitingLoadConfirm(false)
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

      {/* What the selected template will seed, so the admin knows before
          clicking. Requirement 6.3 */}
      <p className="mb-4 text-xs text-gray-500">
        {DEFAULT_PARAMETER_SET_LABELS[selectedSet]} template:{' '}
        {selectedTemplate.length} parameters totalling 100% &mdash;{' '}
        {selectedTemplate.map((p) => `${p.name} (${p.weight}%)`).join(', ')}
      </p>

      {/* Additive-load warning — shown when the category already has
          parameters. Requirements: 6.2, 6.3 */}
      {awaitingLoadConfirm && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
          <p>
            This category already has {parameters.length} parameter
            {parameters.length === 1 ? '' : 's'}. Loading the{' '}
            {DEFAULT_PARAMETER_SET_LABELS[selectedSet]} template{' '}
            <strong>adds</strong> its {selectedTemplate.length} parameters
            instead of replacing the existing ones, including any duplicate
            names. Expect a weight total above 100% that you will have to
            rebalance before saving. Remove the parameters you do not want first
            if you meant to swap templates.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleLoadDefaults}
              className="px-3 py-1.5 bg-yellow-600 text-white rounded hover:bg-yellow-700 text-sm"
              disabled={isPending}
            >
              Load anyway
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

      {/* Error / Success messages */}
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

      {/* Parameter rows */}
      {parameters.length === 0 ? (
        <p className="text-gray-500">
          No parameters defined. Add parameters or load the default template.
        </p>
      ) : (
        <div className="space-y-4">
          {parameters.map((param, index) => (
            <div
              key={param.id}
              className="p-4 bg-white rounded shadow border border-gray-200"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-gray-500">
                  Parameter #{index + 1}
                </span>
                <button
                  onClick={() => removeParameter(param.id)}
                  className="text-red-500 hover:text-red-700 text-sm"
                  disabled={isPending}
                >
                  Remove
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name *
                  </label>
                  <input
                    type="text"
                    value={param.name}
                    onChange={(e) =>
                      updateParameter(param.id, 'name', e.target.value)
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Parameter name"
                    disabled={isPending}
                  />
                </div>

                {/* Weight */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Weight (%)
                  </label>
                  <input
                    type="number"
                    value={param.weight}
                    onChange={(e) =>
                      updateParameter(
                        param.id,
                        'weight',
                        parseFloat(e.target.value) || 0,
                      )
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min={0}
                    max={100}
                    step={0.1}
                    disabled={isPending}
                  />
                </div>

                {/* Description */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={param.description}
                    onChange={(e) =>
                      updateParameter(param.id, 'description', e.target.value)
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Description (optional)"
                    disabled={isPending}
                  />
                </div>

                {/* Min Score */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Min Score
                  </label>
                  <input
                    type="number"
                    value={param.minScore}
                    onChange={(e) =>
                      updateParameter(
                        param.id,
                        'minScore',
                        parseFloat(e.target.value) || 0,
                      )
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min={0}
                    disabled={isPending}
                  />
                </div>

                {/* Max Score */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Score
                  </label>
                  <input
                    type="number"
                    value={param.maxScore}
                    onChange={(e) =>
                      updateParameter(
                        param.id,
                        'maxScore',
                        parseFloat(e.target.value) || 0,
                      )
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min={0}
                    disabled={isPending}
                  />
                </div>

                {/* Scoring Mode Toggle */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Scoring Mode
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateParameter(param.id, 'scoringMode', 'AUTO')
                      }
                      className={`px-3 py-1.5 rounded text-sm font-medium ${
                        param.scoringMode === 'AUTO'
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                      }`}
                      disabled={isPending}
                    >
                      AUTO
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateParameter(param.id, 'scoringMode', 'MANUAL')
                      }
                      className={`px-3 py-1.5 rounded text-sm font-medium ${
                        param.scoringMode === 'MANUAL'
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                      }`}
                      disabled={isPending}
                    >
                      MANUAL
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
