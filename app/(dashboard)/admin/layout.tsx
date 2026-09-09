// app/(dashboard)/admin/layout.tsx
// RSC layout for admin pages.
// Checks session server-side and enforces ADMIN role.
// Requirements: 1.1, 7.2, 7.3, 7.4

import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { ReactNode } from 'react'
import SignOutButton from '@/components/SignOutButton'

export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  if (session.user.role !== 'ADMIN') {
    redirect('/login')
  }

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Fixed Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-slate-900 md:flex">
        {/* Brand */}
        <div className="flex h-16 items-center gap-3 border-b border-slate-700/50 px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm text-white">
            🎯
          </div>
          <span className="text-lg font-bold text-white">PindAI</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <Link
            href="/admin"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span className="text-base">📊</span>
            Dashboard
          </Link>
          <Link
            href="/admin/events"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span className="text-base">📅</span>
            Events
          </Link>
          <Link
            href="/admin/submissions"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span className="text-base">📝</span>
            Submissions
          </Link>
          <Link
            href="/admin/users"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span className="text-base">👥</span>
            Users
          </Link>
        </nav>

        {/* User info at bottom */}
        <div className="border-t border-slate-700/50 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-xs font-medium text-slate-300">
              {session.user.name?.charAt(0)?.toUpperCase() || 'A'}
            </div>
            <div className="flex-1 truncate">
              <p className="truncate text-sm font-medium text-white">
                {session.user.name || 'Admin'}
              </p>
              <p className="truncate text-xs text-slate-400">
                {session.user.email}
              </p>
            </div>
          </div>
          <div className="mt-3">
            <SignOutButton />
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4 md:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm text-white">
          🎯
        </div>
        <span className="text-lg font-bold text-gray-900">PindAI</span>
        <div className="ml-auto">
          <SignOutButton variant="compact" />
        </div>
      </div>

      {/* Mobile navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-gray-200 bg-white md:hidden">
        <Link
          href="/admin"
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-gray-600 hover:text-blue-600"
        >
          <span className="text-lg">📊</span>
          Home
        </Link>
        <Link
          href="/admin/events"
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-gray-600 hover:text-blue-600"
        >
          <span className="text-lg">📅</span>
          Events
        </Link>
        <Link
          href="/admin/submissions"
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-gray-600 hover:text-blue-600"
        >
          <span className="text-lg">📝</span>
          Submissions
        </Link>
        <Link
          href="/admin/users"
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-gray-600 hover:text-blue-600"
        >
          <span className="text-lg">👥</span>
          Users
        </Link>
      </nav>

      {/* Main content */}
      <main className="flex-1 pt-14 pb-16 md:pt-0 md:pb-0 md:ml-64">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  )
}
