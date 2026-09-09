// app/(dashboard)/admin/users/page.tsx
// RSC page listing all users with role badges, create jury form, and
// jury-to-category assignment matrix.
// Requirements: 7.5, 7.6

import { db } from '@/lib/db'
import CreateUserForm from '@/components/CreateUserForm'
import JuryAssignmentMatrix from '@/components/JuryAssignmentMatrix'

export default async function AdminUsersPage() {
  // Fetch all users
  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  // Fetch all categories (with event name for the assignment matrix)
  const categories = await db.category.findMany({
    select: {
      id: true,
      name: true,
      event: { select: { name: true } },
    },
    orderBy: [{ event: { name: 'asc' } }, { name: 'asc' }],
  })

  // Fetch all existing jury assignments
  const assignments = await db.categoryJury.findMany({
    select: {
      categoryId: true,
      userId: true,
    },
  })

  // Prepare data for the assignment matrix
  const juryUsers = users
    .filter((u) => u.role === 'JURY')
    .map((u) => ({ id: u.id, name: u.name, email: u.email }))

  const categoriesForMatrix = categories.map((c) => ({
    id: c.id,
    name: c.name,
    eventName: c.event.name,
  }))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage jury accounts and category assignments
        </p>
      </div>

      {/* Users table */}
      <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Role
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {users.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                  No users yet.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr
                  key={user.id}
                  className="hover:bg-gray-50/50 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {user.name}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{user.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full ${
                        user.role === 'ADMIN'
                          ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-200'
                          : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(user.createdAt).toLocaleDateString('id-ID')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create jury form */}
      <CreateUserForm />

      {/* Jury assignment matrix */}
      <JuryAssignmentMatrix
        juryUsers={juryUsers}
        categories={categoriesForMatrix}
        assignments={assignments}
      />
    </div>
  )
}
