// components/ProjectComparison.tsx
// Client component for side-by-side comparison of selected projects' scores.
// Requirements: 8.4

'use client'

import { Fragment, useState } from 'react'

interface ParameterInfo {
  id: string
  name: string
  weight: number
  minScore: number
  maxScore: number
}

interface ProjectForComparison {
  id: string
  participantName: string
  teamName: string | null
  url: string
  finalScore: number | null
  rank: number | null
  aiScores: Array<{ parameterId: string; score: number; reasoning: string }>
  juryScores: Array<{
    parameterId: string
    juryId: string
    score: number
    comment: string | null
  }>
}

interface ProjectComparisonProps {
  projects: ProjectForComparison[]
  parameters: ParameterInfo[]
}

export default function ProjectComparison({
  projects,
  parameters,
}: ProjectComparisonProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  function toggleSelection(projectId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(projects.map((p) => p.id)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  const selectedProjects = projects.filter((p) => selectedIds.has(p.id))

  function getAiScore(
    project: ProjectForComparison,
    parameterId: string,
  ): number | null {
    const found = project.aiScores.find((s) => s.parameterId === parameterId)
    return found ? found.score : null
  }

  function getJuryScore(
    project: ProjectForComparison,
    parameterId: string,
  ): number | null {
    const scores = project.juryScores.filter(
      (s) => s.parameterId === parameterId,
    )
    if (scores.length === 0) return null
    return scores.reduce((sum, s) => sum + s.score, 0) / scores.length
  }

  /**
   * Returns a Tailwind background class to highlight cells relative to
   * the min/max within the selected projects for a given parameter.
   */
  function getCellHighlight(
    value: number | null,
    parameterId: string,
    type: 'ai' | 'jury',
  ): string {
    if (value === null || selectedProjects.length < 2) return ''

    const values = selectedProjects
      .map((p) =>
        type === 'ai'
          ? getAiScore(p, parameterId)
          : getJuryScore(p, parameterId),
      )
      .filter((v): v is number => v !== null)

    if (values.length < 2) return ''

    const max = Math.max(...values)
    const min = Math.min(...values)

    if (max === min) return ''

    if (value === max) return 'bg-green-50'
    if (value === min) return 'bg-red-50'
    return ''
  }

  return (
    <div>
      {/* Project selection */}
      <div className="bg-white rounded shadow p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Select Projects to Compare</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAll}
              className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid gap-2 max-h-64 overflow-y-auto">
          {projects.map((project) => (
            <label
              key={project.id}
              className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                selectedIds.has(project.id)
                  ? 'bg-blue-50 border border-blue-200'
                  : 'hover:bg-gray-50 border border-transparent'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(project.id)}
                onChange={() => toggleSelection(project.id)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">
                  #{project.rank} — {project.participantName}
                </span>
                {project.teamName && (
                  <span className="text-xs text-gray-500 ml-2">
                    ({project.teamName})
                  </span>
                )}
              </div>
              <span className="text-sm text-gray-600 tabular-nums">
                {project.finalScore !== null
                  ? project.finalScore.toFixed(2)
                  : '—'}
              </span>
            </label>
          ))}
        </div>

        {projects.length === 0 && (
          <p className="text-gray-500 text-sm">No projects in this category.</p>
        )}
      </div>

      {/* Comparison table */}
      {selectedProjects.length >= 2 ? (
        <div className="bg-white rounded shadow overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border border-gray-200 px-3 py-2 bg-gray-50 text-left font-medium text-gray-700 sticky left-0 z-10 min-w-[180px]">
                  Parameter
                </th>
                {selectedProjects.map((project) => (
                  <th
                    key={project.id}
                    className="border border-gray-200 px-3 py-2 bg-gray-50 text-center font-medium text-gray-700 min-w-[160px]"
                    colSpan={2}
                  >
                    <div>{project.participantName}</div>
                    {project.teamName && (
                      <div className="text-xs text-gray-400 font-normal">
                        {project.teamName}
                      </div>
                    )}
                    <div className="text-xs text-gray-400 font-normal">
                      Rank #{project.rank}
                    </div>
                  </th>
                ))}
              </tr>
              <tr>
                <th className="border border-gray-200 px-3 py-1 bg-gray-50 text-left text-xs text-gray-500 sticky left-0 z-10">
                  (Weight)
                </th>
                {selectedProjects.map((project) => (
                  <Fragment key={project.id}>
                    <th className="border border-gray-200 px-2 py-1 bg-gray-50 text-center text-xs text-gray-500">
                      AI Score
                    </th>
                    <th className="border border-gray-200 px-2 py-1 bg-gray-50 text-center text-xs text-gray-500">
                      Jury Score
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {parameters.map((param) => (
                <tr key={param.id}>
                  <td className="border border-gray-200 px-3 py-2 sticky left-0 bg-white z-10">
                    <div className="font-medium">{param.name}</div>
                    <div className="text-xs text-gray-400">
                      Weight: {param.weight}%
                    </div>
                  </td>
                  {selectedProjects.map((project) => {
                    const ai = getAiScore(project, param.id)
                    const jury = getJuryScore(project, param.id)

                    return (
                      <Fragment key={project.id}>
                        <td
                          className={`border border-gray-200 px-2 py-2 text-center tabular-nums ${getCellHighlight(ai, param.id, 'ai')}`}
                        >
                          {ai !== null ? ai.toFixed(1) : '—'}
                        </td>
                        <td
                          className={`border border-gray-200 px-2 py-2 text-center tabular-nums ${getCellHighlight(jury, param.id, 'jury')}`}
                        >
                          {jury !== null ? jury.toFixed(1) : '—'}
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              ))}

              {/* Final score row */}
              <tr className="bg-gray-50 font-semibold">
                <td className="border border-gray-200 px-3 py-2 sticky left-0 bg-gray-50 z-10">
                  Final Score
                </td>
                {selectedProjects.map((project) => (
                  <td
                    key={project.id}
                    className="border border-gray-200 px-2 py-2 text-center tabular-nums"
                    colSpan={2}
                  >
                    {project.finalScore !== null
                      ? project.finalScore.toFixed(2)
                      : '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : selectedProjects.length === 1 ? (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-4 text-sm text-yellow-800">
          Select at least 2 projects to compare side-by-side.
        </div>
      ) : null}
    </div>
  )
}
