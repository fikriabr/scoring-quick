// components/CreateUserForm.tsx
// Client component for creating jury users via POST /api/users.
// Requirements: 7.5

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function CreateUserForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    const form = e.currentTarget
    const formData = new FormData(form)
    const name = formData.get('name') as string
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    if (!name || !email || !password) {
      setError('All fields are required.')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, role: 'JURY' }),
        })

        if (!res.ok) {
          const data = await res.json()
          setError(data.message || 'Failed to create user.')
          return
        }

        setSuccess(`Jury user "${name}" created successfully.`)
        form.reset()
        router.refresh()
      } catch {
        setError('An unexpected error occurred.')
      }
    })
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Create Jury User
      </h2>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="create-user-name"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Name <span className="text-red-500">*</span>
          </label>
          <input
            id="create-user-name"
            name="name"
            type="text"
            maxLength={255}
            required
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition-colors placeholder:text-gray-400 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="create-user-email"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Email <span className="text-red-500">*</span>
          </label>
          <input
            id="create-user-email"
            name="email"
            type="email"
            required
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition-colors placeholder:text-gray-400 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="create-user-password"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Password <span className="text-red-500">*</span>
          </label>
          <input
            id="create-user-password"
            name="password"
            type="password"
            minLength={6}
            required
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 transition-colors placeholder:text-gray-400 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-gray-500">Minimum 6 characters</p>
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? 'Creating...' : 'Create Jury User'}
        </button>
      </form>
    </div>
  )
}
