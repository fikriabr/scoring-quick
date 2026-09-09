// app/(dashboard)/admin/submissions/new/page.tsx
// RSC page for adding submissions: single project form + CSV bulk upload.
// Split out from the submissions list so the list page stays focused on
// browsing existing projects.
// Requirements: 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4

import Link from 'next/link'
import { db } from '@/lib/db'
import SubmissionForm from '@/components/SubmissionForm'

export default async function NewSubmissionPage() {
  // Categories for the form's Category select (with event name for context).
  const categories = await db.category.findMany({
    orderBy: { name: 'asc' },
    include: { event: { select: { name: true } } },
  })

  const serializedCategories = categories.map((c) => ({
    id: c.id,
    name: c.name,
    eventName: c.event.name,
  }))

  return (
    <div className="space-y-8">
      {/* Page header with a back link to the list */}
      <div>
        <Link
          href="/admin/submissions"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <span aria-hidden="true">←</span> Back to submissions
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">
          Add Submission
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Submit a single project or bulk upload via CSV
        </p>
      </div>

      {/* Client component handles single submission + CSV upload */}
      <SubmissionForm categories={serializedCategories} />
    </div>
  )
}
