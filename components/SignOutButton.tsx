// components/SignOutButton.tsx
// Client-side sign-out control shared by the admin and jury layouts.
// Clears the session cookie via NextAuth and lands the user back on /login.
'use client'

import { signOut } from 'next-auth/react'
import { useState } from 'react'

interface SignOutButtonProps {
  /**
   * `sidebar` — full-width button for the dark sidebars.
   * `compact` — icon-sized button for the mobile header, where the sidebar
   * (and with it the desktop button) is hidden.
   */
  variant?: 'sidebar' | 'compact'
}

const styles = {
  // Neutral white-alpha colours so the same button reads correctly on both
  // dark sidebars: slate for admin, indigo for jury.
  sidebar:
    'flex w-full items-center justify-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50',
  compact:
    'flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50',
} as const

export default function SignOutButton({
  variant = 'sidebar',
}: SignOutButtonProps) {
  const [loading, setLoading] = useState(false)

  async function handleSignOut() {
    setLoading(true)
    // NextAuth performs the redirect itself, so the button stays disabled
    // until the browser navigates away.
    await signOut({ redirectTo: '/login' })
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className={styles[variant]}
    >
      <span aria-hidden="true">↩</span>
      {loading ? 'Signing out...' : 'Sign Out'}
    </button>
  )
}
