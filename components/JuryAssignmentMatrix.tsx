// components/JuryAssignmentMatrix.tsx
// Client component for displaying and toggling jury-category assignments.
// Requirements: 7.6

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface JuryUser {
  id: string
  name: string
  email: string
}

interface Category {
  id: string
  name: string
  eventName: string
}

interface Assignment {
  categoryId: string
  userId: string
}

interface JuryAssignmentMatrixProps {
  juryUsers: JuryUser[]
  categories: Category[]
  assignments: Assignment[]
}

export default function JuryAssignmentMatrix({
  juryUsers,
  categories,
  assignments,
}: JuryAssignmentMatrixProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [localAssignments, setLocalAssignments] =
    useState<Assignment[]>(assignments)
  const [error, setError] = useState<string | null>(null)
  const [processingCell, setProcessingCell] = useState<string | null>(null)

  function isAssigned(userId: string, categoryId: string): boolean {
    return localAssignments.some(
      (a) => a.userId === userId && a.categoryId === categoryId,
    )
  }

  function toggleAssignment(userId: string, categoryId: string) {
    const cellKey = `${userId}-${categoryId}`
    setError(null)
    setProcessingCell(cellKey)

    const assigned = isAssigned(userId, categoryId)

    startTransition(async () => {
      try {
        if (assigned) {
          // Unassign: DELETE /api/categories/[id]/jury
          const res = await fetch(`/api/categories/${categoryId}/jury`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
          })

          if (!res.ok) {
            const data = await res.json()
            setError(data.message || 'Failed to unassign jury.')
            setProcessingCell(null)
            return
          }

          setLocalAssignments((prev) =>
            prev.filter(
              (a) => !(a.userId === userId && a.categoryId === categoryId),
            ),
          )
        } else {
          // Assign: POST /api/categories/[id]/jury
          const res = await fetch(`/api/categories/${categoryId}/jury`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
          })

          if (!res.ok) {
            const data = await res.json()
            setError(data.message || 'Failed to assign jury.')
            setProcessingCell(null)
            return
          }

          setLocalAssignments((prev) => [...prev, { categoryId, userId }])
        }

        setProcessingCell(null)
        router.refresh()
      } catch {
        setError('An unexpected error occurred.')
        setProcessingCell(null)
      }
    })
  }

  if (juryUsers.length === 0) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Jury Assignment Matrix
        </h2>
        <p className="text-gray-500">
          No jury users yet. Create a jury user first.
        </p>
      </div>
    )
  }

  if (categories.length === 0) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Jury Assignment Matrix
        </h2>
        <p className="text-gray-500">
          No categories available. Create an event with categories first.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Jury Assignment Matrix
      </h2>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border border-gray-100 px-3 py-2 bg-gray-50/50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Jury
              </th>
              {categories.map((cat) => (
                <th
                  key={cat.id}
                  className="border border-gray-100 px-3 py-2 bg-gray-50/50 text-center text-xs font-medium uppercase tracking-wider text-gray-500"
                >
                  <div>{cat.name}</div>
                  <div className="text-[10px] text-gray-400 font-normal normal-case tracking-normal">
                    {cat.eventName}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {juryUsers.map((user) => (
              <tr key={user.id}>
                <td className="border border-gray-100 px-3 py-2">
                  <div className="font-medium text-gray-900">{user.name}</div>
                  <div className="text-xs text-gray-500">{user.email}</div>
                </td>
                {categories.map((cat) => {
                  const cellKey = `${user.id}-${cat.id}`
                  const assigned = isAssigned(user.id, cat.id)
                  const processing = processingCell === cellKey

                  return (
                    <td
                      key={cat.id}
                      className="border border-gray-100 px-3 py-2 text-center"
                    >
                      <button
                        type="button"
                        onClick={() => toggleAssignment(user.id, cat.id)}
                        disabled={isPending && processing}
                        className={`w-8 h-8 rounded-lg inline-flex items-center justify-center transition-colors ${
                          assigned
                            ? 'bg-blue-600 text-white shadow-sm hover:bg-blue-700'
                            : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                        aria-label={
                          assigned
                            ? `Unassign ${user.name} from ${cat.name}`
                            : `Assign ${user.name} to ${cat.name}`
                        }
                      >
                        {processing ? (
                          <span className="animate-pulse">...</span>
                        ) : assigned ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        ) : (
                          <span className="text-lg leading-none">&ndash;</span>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
