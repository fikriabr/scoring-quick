// app/(dashboard)/jury/layout.tsx
// RSC layout for jury dashboard pages.
// Checks session server-side and redirects to login if not authenticated.
// Requirements: 6.1, 7.6

import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { ReactNode } from 'react'
import SignOutButton from '@/components/SignOutButton'

export default async function JuryLayout({
  children,
}: {
  children: ReactNode
}) {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar navigation */}
      <aside className="w-64 bg-indigo-900 text-white p-4 flex flex-col">
        <h1 className="text-xl font-bold mb-6">Jury Panel</h1>
        <nav className="flex-1">
          <ul className="space-y-2">
            <li>
              <Link
                href="/jury/projects"
                className="block px-3 py-2 rounded hover:bg-indigo-700"
              >
                Projects
              </Link>
            </li>
          </ul>
        </nav>

        {/* Signed-in jury and sign-out, pinned to the bottom */}
        <div className="border-t border-indigo-700/60 pt-4 space-y-3">
          <div className="truncate">
            <p className="truncate text-sm font-medium">
              {session.user.name || 'Jury'}
            </p>
            <p className="truncate text-xs text-indigo-300">
              {session.user.email}
            </p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-6 bg-gray-50">{children}</main>
    </div>
  )
}
