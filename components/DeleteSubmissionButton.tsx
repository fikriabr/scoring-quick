// components/DeleteSubmissionButton.tsx
// Soft-deletes a submission (sets Project.isActive = false) via
// DELETE /api/submissions/[id]. Used on both the submissions list (inline
// per row) and the project detail page.

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface DeleteSubmissionButtonProps {
  projectId: string
  participantName: string
  /** Where to send the browser after a successful delete. Omit to stay put and just refresh. */
  redirectTo?: string
  className?: string
}

export default function DeleteSubmissionButton({
  projectId,
  participantName,
  redirectTo,
  className,
}: DeleteSubmissionButtonProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    const confirmed = window.confirm(
      `Delete the submission from "${participantName}"? It will be hidden from lists and leaderboards, but its history is kept and can be restored by an admin with database access.`,
    )
    if (!confirmed) return

    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(`/api/submissions/${projectId}`, {
          method: 'DELETE',
        })
        const body = await res.json().catch(() => null)

        if (!res.ok) {
          setError(errorText(res.status, body))
          return
        }

        if (redirectTo) {
          router.push(redirectTo)
        }
        router.refresh()
      } catch {
        setError('Network error. Please try again.')
      }
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={
          className ??
          'px-2.5 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 hover:bg-red-100 transition-colors disabled:cursor-not-allowed disabled:opacity-50'
        }
      >
        {isPending ? 'Deleting...' : 'Delete'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  )
}

function errorText(status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: unknown }).message
      : undefined

  if (typeof message === 'string' && message.trim() !== '') {
    if (status === 403) return `Access denied: ${message}`
    if (status === 404) return `Not found: ${message}`
    return message
  }

  switch (status) {
    case 403:
      return 'Access denied. Only Admins may delete submissions.'
    case 404:
      return 'Project not found. It may already have been deleted.'
    case 429:
      return 'Too many requests. Please wait a moment and try again.'
    default:
      return `Failed to delete (HTTP ${status}).`
  }
}
