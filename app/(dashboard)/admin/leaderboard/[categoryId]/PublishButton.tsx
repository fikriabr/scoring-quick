// app/(dashboard)/admin/leaderboard/[categoryId]/PublishButton.tsx
// Client component for publishing a category and showing the public leaderboard URL.
// Requirements: 8.5
'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'

interface PublishButtonProps {
  categoryId: string
  isPublished: boolean
  publicToken: string | null
}

// The origin never changes for the lifetime of the page, so there is nothing
// to subscribe to.
const subscribeToOrigin = () => () => {}
const getOrigin = () => window.location.origin
// `window` is undefined during SSR and on the hydration pass; the relative
// path is shown until the origin is available on the client.
const getServerOrigin = () => ''

export default function PublishButton({
  categoryId,
  isPublished,
  publicToken,
}: PublishButtonProps) {
  const [published, setPublished] = useState(isPublished)
  const [token, setToken] = useState(publicToken)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getOrigin,
    getServerOrigin
  )

  const publicPath = token ? `/public/leaderboard/${token}` : null
  const publicUrl = publicPath ? `${origin}${publicPath}` : null

  async function handlePublish() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/categories/${categoryId}/publish`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.message ?? 'Failed to publish')
        return
      }
      const category = await res.json()
      setPublished(true)
      setToken(category.publicToken)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (published && publicPath && publicUrl) {
    return (
      <div className="flex flex-col gap-2">
        <span className="inline-flex items-center px-3 py-1 text-sm font-medium bg-green-100 text-green-800 rounded">
          Published
        </span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Public URL:</span>
          <Link
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline break-all"
          >
            {publicUrl}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handlePublish}
        disabled={loading}
        className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Publishing...' : 'Publish Leaderboard'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
