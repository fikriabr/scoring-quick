// components/SubmissionForm.tsx
// Client component for single project submission and CSV bulk upload.
// Also provides retry crawl/score buttons for inline actions.
// Requirements: 1.3, 1.4, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
// Same rule module the server-side schemas use, so client and server can never
// drift apart.
import { validateProjectUrl } from '@/lib/validators/url-rules'
// Prisma-free module, so the shared limit can be read without pulling the
// Prisma runtime (which `@/lib/validators/schemas` does) into the bundle.
import {
  IDEA_DOC_REQUIRED_MESSAGE,
  MAX_IDEA_DOC_LENGTH,
  MAX_SOURCE_CODE_LENGTH,
} from '@/lib/validators/source-code-rules'

interface Category {
  id: string
  name: string
  eventName: string
}

// Field limits mirrored from lib/validators/schemas.ts (SubmissionSchema),
// which in turn mirrors the Project table on Neon PostgreSQL. The Source Code
// limit is no longer mirrored by hand: it is imported below from the same
// Prisma-free module the schemas read it from.
const MAX_NAME_LENGTH = 255

const FORM_COPY = {
  urlLabel: 'Project URL',
  urlPlaceholder: 'https://example.com/my-project',
  urlHelp:
    'Optional if Source Code is provided below. Any hostname is accepted, as long as the URL uses http or https.',
  sourceCodePlaceholder: "Paste the page's HTML markup here...",
  sourceCodeHelp:
    "The AI scorer derives the page's HTML structure from this. Leave blank to let the crawler fetch the markup from the URL instead — required if no URL is provided above.",
  urlOrSourceCodeError:
    'Provide a Project URL or upload/paste Source Code — at least one is required.',
  successMessage:
    'Project submitted successfully. Fetching the page, then AI scoring of the idea and the HTML starts.',
  ideaDocPlaceholder: '# Project idea\n\nProblem, target users, proposed solution, feasibility, impact...',
  ideaDocHelp:
    'Required. Scored on the Idea parameters only — the idea evaluator never sees the HTML, and the HTML evaluator never sees this document.',
}

/**
 * Reads a text file picked in an <input type="file">, enforcing the length
 * cap on both the byte size (cheap, before reading) and the decoded text.
 */
async function readTextFile(file: File, maxLength: number): Promise<{ text: string } | { error: string }> {
  if (file.size > maxLength) {
    return { error: `File is too large — must not exceed ${maxLength.toLocaleString()} characters.` }
  }
  try {
    const text = await file.text()
    if (text.length > maxLength) {
      return { error: `File content must not exceed ${maxLength.toLocaleString()} characters.` }
    }
    return { text }
  } catch {
    return { error: 'Could not read the selected file. Please try again.' }
  }
}

interface SubmissionFormProps {
  categories: Category[]
}

export default function SubmissionForm({ categories }: SubmissionFormProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'single' | 'csv'>('single')

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      {/* Tab selector */}
      <div className="flex gap-6 border-b border-gray-200 mb-6">
        <button
          type="button"
          onClick={() => setActiveTab('single')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'single'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Single Submission
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('csv')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'csv'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          CSV Upload
        </button>
      </div>

      {activeTab === 'single' ? (
        <SingleSubmissionForm
          categories={categories}
          onSuccess={() => router.refresh()}
        />
      ) : (
        <CsvUploadForm
          categories={categories}
          onSuccess={() => router.refresh()}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------
// SingleSubmissionForm
// Form for submitting a single project URL. The project type is picked first
// because it decides which URL rule and which field copy apply below.
// Requirements: 1.3, 1.4, 2.4, 2.5
// -----------------------------------------------------------------------
function SingleSubmissionForm({
  categories,
  onSuccess,
}: {
  categories: Category[]
  onSuccess: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [sourceCode, setSourceCode] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [ideaDoc, setIdeaDoc] = useState('')
  const [ideaFileName, setIdeaFileName] = useState<string | null>(null)
  const [ideaFileError, setIdeaFileError] = useState<string | null>(null)
  // Tracked purely so the Source Code label can flip between "optional" and
  // "required" live as the admin fills in (or clears) the URL field.
  const [urlValue, setUrlValue] = useState('')
  const sourceCodeRequired = urlValue.trim().length === 0

  const copy = FORM_COPY

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setFileError(null)
    const result = await readTextFile(file, MAX_SOURCE_CODE_LENGTH)
    if ('error' in result) {
      setFileError(result.error)
      return
    }
    setSourceCode(result.text)
    setFileName(file.name)
    setErrors((prev) => ({ ...prev, sourceCode: '' }))
  }

  async function handleIdeaFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setIdeaFileError(null)
    const result = await readTextFile(file, MAX_IDEA_DOC_LENGTH)
    if ('error' in result) {
      setIdeaFileError(result.error)
      return
    }
    setIdeaDoc(result.text)
    setIdeaFileName(file.name)
    setErrors((prev) => ({ ...prev, ideaDoc: '' }))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErrors({})
    setGlobalError(null)
    setSuccessMessage(null)

    const form = e.currentTarget
    const formData = new FormData(form)

    // Field names and shapes match SubmissionSchema, which maps 1:1 onto the
    // Project columns in Neon PostgreSQL (url, participantName, teamName,
    // sourceCode, categoryId). Empty optional fields are sent as undefined so
    // the service writes SQL NULL rather than an empty string.
    const payload = {
      url: (formData.get('url') as string).trim() || undefined,
      participantName: (formData.get('participantName') as string).trim(),
      teamName: (formData.get('teamName') as string).trim() || undefined,
      sourceCode: sourceCode.trim() || undefined,
      ideaDoc: ideaDoc.trim() || undefined,
      categoryId: formData.get('categoryId') as string,
    }

    // Client-side validation mirroring SubmissionSchema so invalid input is
    // reported per-field instead of coming back as one server-side string.
    const fieldErrors: Record<string, string> = {}
    if (payload.url) {
      // Same rule, same argument the server gets — so the single submission
      // route, the CSV import, and this form always agree.
      const urlCheck = validateProjectUrl(payload.url)
      if (!urlCheck.ok) fieldErrors.url = urlCheck.message
    } else if (!payload.sourceCode) {
      // Neither field is present — SubmissionSchema requires at least one,
      // and the error is attached to sourceCode there too so both surfaces
      // point the admin at the same field.
      fieldErrors.sourceCode = copy.urlOrSourceCodeError
    }
    if (!payload.participantName) {
      fieldErrors.participantName = 'Participant name is required'
    } else if (payload.participantName.length > MAX_NAME_LENGTH) {
      fieldErrors.participantName = `Participant name must not exceed ${MAX_NAME_LENGTH} characters`
    }
    if (payload.teamName && payload.teamName.length > MAX_NAME_LENGTH) {
      fieldErrors.teamName = `Team name must not exceed ${MAX_NAME_LENGTH} characters`
    }
    if (
      payload.sourceCode &&
      payload.sourceCode.length > MAX_SOURCE_CODE_LENGTH
    ) {
      fieldErrors.sourceCode = `Source code must not exceed ${MAX_SOURCE_CODE_LENGTH.toLocaleString()} characters`
    }
    if (!payload.ideaDoc) {
      fieldErrors.ideaDoc = IDEA_DOC_REQUIRED_MESSAGE
    } else if (payload.ideaDoc.length > MAX_IDEA_DOC_LENGTH) {
      fieldErrors.ideaDoc = `Idea document must not exceed ${MAX_IDEA_DOC_LENGTH.toLocaleString()} characters`
    }
    if (!payload.categoryId) fieldErrors.categoryId = 'Category is required'

    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors)
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/submissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (!res.ok) {
          const data = await res.json()
          if (data.code === 'DUPLICATE_URL') {
            setGlobalError(
              'This URL has already been submitted to this category.',
            )
          } else if (data.code === 'VALIDATION_ERROR') {
            setGlobalError(data.message)
          } else {
            setGlobalError(data.message || 'An error occurred.')
          }
          return
        }

        setSuccessMessage(copy.successMessage)
        form.reset()
        setSourceCode('')
        setFileName(null)
        setFileError(null)
        setIdeaDoc('')
        setIdeaFileName(null)
        setIdeaFileError(null)
        setUrlValue('')
        onSuccess()
      } catch {
        setGlobalError('Network error. Please try again.')
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      {globalError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {globalError}
        </div>
      )}
      {successMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm">
          {successMessage}
        </div>
      )}

      {/* Category select */}
      <div>
        <label
          htmlFor="categoryId"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Category <span className="text-red-500">*</span>
        </label>
        <select
          id="categoryId"
          name="categoryId"
          required
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 text-sm transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.categoryId ? 'border-red-400' : 'border-gray-200'
          }`}
        >
          <option value="">Select a category...</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.eventName} — {cat.name}
            </option>
          ))}
        </select>
        {errors.categoryId && (
          <p className="mt-1.5 text-sm text-red-600">{errors.categoryId}</p>
        )}
      </div>

      {/* URL field — optional as long as Source Code is provided below */}
      <div>
        <label
          htmlFor="url"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          {copy.urlLabel} <span className="text-gray-400">(optional)</span>
        </label>
        <input
          id="url"
          name="url"
          type="url"
          placeholder={copy.urlPlaceholder}
          onChange={(e) => setUrlValue(e.target.value)}
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 text-sm transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.url ? 'border-red-400' : 'border-gray-200'
          }`}
        />
        {errors.url && (
          <p className="mt-1.5 text-sm text-red-600">{errors.url}</p>
        )}
        <p className="mt-1.5 text-xs text-gray-400">{copy.urlHelp}</p>
      </div>

      {/* Participant Name field */}
      <div>
        <label
          htmlFor="participantName"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Participant Name <span className="text-red-500">*</span>
        </label>
        <input
          id="participantName"
          name="participantName"
          type="text"
          maxLength={MAX_NAME_LENGTH}
          required
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 text-sm transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.participantName ? 'border-red-400' : 'border-gray-200'
          }`}
        />
        {errors.participantName && (
          <p className="mt-1.5 text-sm text-red-600">
            {errors.participantName}
          </p>
        )}
      </div>

      {/* Team Name field (optional) */}
      <div>
        <label
          htmlFor="teamName"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Team Name <span className="text-gray-400">(optional)</span>
        </label>
        <input
          id="teamName"
          name="teamName"
          type="text"
          maxLength={MAX_NAME_LENGTH}
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 text-sm transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.teamName ? 'border-red-400' : 'border-gray-200'
          }`}
        />
        {errors.teamName && (
          <p className="mt-1.5 text-sm text-red-600">{errors.teamName}</p>
        )}
      </div>

      {/* Idea document — Project.ideaDoc, the only evidence of the IDEA
          track. Always required. */}
      <div>
        <label
          htmlFor="ideaDoc"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Idea Document (Markdown) <span className="text-red-500">*</span>
        </label>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label
            htmlFor="ideaDocFile"
            className="cursor-pointer rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
          >
            Upload .md file...
          </label>
          <input
            id="ideaDocFile"
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={handleIdeaFileChange}
            className="hidden"
          />
          {ideaFileName && (
            <span className="text-xs text-gray-500">
              Loaded from <span className="font-medium">{ideaFileName}</span>
            </span>
          )}
        </div>
        {ideaFileError && (
          <p className="mb-1.5 text-sm text-red-600">{ideaFileError}</p>
        )}

        <textarea
          id="ideaDoc"
          name="ideaDoc"
          rows={8}
          maxLength={MAX_IDEA_DOC_LENGTH}
          placeholder={copy.ideaDocPlaceholder}
          value={ideaDoc}
          onChange={(e) => {
            setIdeaDoc(e.target.value)
            setIdeaFileName(null)
          }}
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 font-mono text-xs transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.ideaDoc ? 'border-red-400' : 'border-gray-200'
          }`}
        />
        {errors.ideaDoc && (
          <p className="mt-1.5 text-sm text-red-600">{errors.ideaDoc}</p>
        )}
        <div className="mt-1.5 flex justify-between gap-4 text-xs text-gray-400">
          <p>{copy.ideaDocHelp}</p>
          <p className="shrink-0 tabular-nums">
            {ideaDoc.length.toLocaleString()} /{' '}
            {MAX_IDEA_DOC_LENGTH.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Source Code field — Project.sourceCode, the HTML track's primary
          evidence. Required whenever no Project URL is provided above. */}
      <div>
        <label
          htmlFor="sourceCode"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          HTML Source Code{' '}
          {sourceCodeRequired ? (
            <span className="text-red-500">*</span>
          ) : (
            <span className="text-gray-400">(optional)</span>
          )}
        </label>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label
            htmlFor="sourceCodeFile"
            className="cursor-pointer rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
          >
            Upload HTML file...
          </label>
          <input
            id="sourceCodeFile"
            type="file"
            accept=".html,.htm,text/html"
            onChange={handleFileChange}
            className="hidden"
          />
          {fileName && (
            <span className="text-xs text-gray-500">
              Loaded from <span className="font-medium">{fileName}</span>
            </span>
          )}
        </div>
        {fileError && (
          <p className="mb-1.5 text-sm text-red-600">{fileError}</p>
        )}

        <textarea
          id="sourceCode"
          name="sourceCode"
          rows={8}
          maxLength={MAX_SOURCE_CODE_LENGTH}
          placeholder={copy.sourceCodePlaceholder}
          value={sourceCode}
          onChange={(e) => {
            setSourceCode(e.target.value)
            setFileName(null)
          }}
          className={`w-full px-3 py-2.5 rounded-lg border bg-gray-50 font-mono text-xs transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
            errors.sourceCode ? 'border-red-400' : 'border-gray-200'
          }`}
        />
        {errors.sourceCode && (
          <p className="mt-1.5 text-sm text-red-600">{errors.sourceCode}</p>
        )}
        <div className="mt-1.5 flex justify-between gap-4 text-xs text-gray-400">
          <p>{copy.sourceCodeHelp}</p>
          <p className="shrink-0 tabular-nums">
            {sourceCode.length.toLocaleString()} /{' '}
            {MAX_SOURCE_CODE_LENGTH.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Submit button */}
      <button
        type="submit"
        disabled={isPending}
        className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg shadow-sm hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? 'Submitting...' : 'Submit Project'}
      </button>
    </form>
  )
}

// -----------------------------------------------------------------------
// CsvUploadForm
// Form for bulk CSV file upload
// -----------------------------------------------------------------------
function CsvUploadForm({
  categories,
  onSuccess,
}: {
  categories: Category[]
  onSuccess: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    imported: number
    errors: { row: number; message: string }[]
  } | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setGlobalError(null)
    setResult(null)

    const form = e.currentTarget
    const formData = new FormData(form)

    const file = formData.get('file') as File | null
    const categoryId = formData.get('categoryId') as string

    if (!file || file.size === 0) {
      setGlobalError('Please select a CSV file.')
      return
    }

    if (!categoryId) {
      setGlobalError('Please select a category.')
      return
    }

    startTransition(async () => {
      try {
        const uploadData = new FormData()
        uploadData.append('file', file)
        uploadData.append('categoryId', categoryId)

        const res = await fetch('/api/submissions/bulk', {
          method: 'POST',
          body: uploadData,
        })

        if (!res.ok) {
          const data = await res.json()
          setGlobalError(data.message || 'An error occurred during import.')
          return
        }

        const data = await res.json()
        setResult(data)
        if (data.imported > 0) {
          onSuccess()
        }
      } catch {
        setGlobalError('Network error. Please try again.')
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      {globalError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {globalError}
        </div>
      )}

      {/* Category select */}
      <div>
        <label
          htmlFor="csv-categoryId"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          Category <span className="text-red-500">*</span>
        </label>
        <select
          id="csv-categoryId"
          name="categoryId"
          required
          className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-sm transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        >
          <option value="">Select a category...</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.eventName} — {cat.name}
            </option>
          ))}
        </select>
      </div>

      {/* File input */}
      <div>
        <label
          htmlFor="csv-file"
          className="block text-sm font-medium text-gray-700 mb-1.5"
        >
          CSV File <span className="text-red-500">*</span>
        </label>
        <input
          id="csv-file"
          name="file"
          type="file"
          accept=".csv"
          required
          className="w-full px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-sm transition-colors file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
        <p className="mt-1.5 text-xs text-gray-400">
          CSV columns: <code>participant_name</code> and{' '}
          <code>idea_doc</code> (markdown, required),{' '}
          <code>url</code> and <code>source_code</code> (each optional, but a
          row needs at least one of them), <code>team_name</code> (optional).
          Header casing and spacing don&apos;t matter, and{' '}
          <code>,</code> <code>;</code> or tab separated files all work.
        </p>
      </div>

      {/* Submit button */}
      <button
        type="submit"
        disabled={isPending}
        className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg shadow-sm hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? 'Importing...' : 'Upload CSV'}
      </button>

      {/* Import results */}
      {result && (
        <div className="mt-4 space-y-3">
          <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm">
            Successfully imported {result.imported} project(s).
          </div>

          {result.errors.length > 0 && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm">
              <p className="font-medium text-amber-800 mb-2">
                {result.errors.length} row(s) had errors:
              </p>
              <ul className="list-disc list-inside text-amber-700 space-y-1 max-h-48 overflow-y-auto">
                {result.errors.map((err, idx) => (
                  <li key={idx}>
                    <span className="font-medium">Row {err.row}:</span>{' '}
                    {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  )
}

// -----------------------------------------------------------------------
// RetryButton (exported for use in project tables)
// Calls the crawl or score API endpoint to retry processing.
// -----------------------------------------------------------------------
export function RetryButton({
  projectId,
  type,
  disabled,
  title,
}: {
  projectId: string
  type: 'crawl' | 'score'
  disabled?: boolean
  /** Tooltip shown on hover — used to explain *why* the button is disabled. */
  title?: string
}) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const label = type === 'crawl' ? 'Retry Crawl' : 'Retry Score'

  function handleClick() {
    startTransition(async () => {
      const endpoint =
        type === 'crawl'
          ? `/api/crawl/${projectId}?action=retrigger`
          : `/api/score/${projectId}`

      await fetch(endpoint, { method: 'POST' })
      router.refresh()
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || isPending}
      title={title}
      className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
        disabled || isPending
          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
          : type === 'crawl'
            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
            : 'bg-purple-50 text-purple-700 hover:bg-purple-100'
      }`}
    >
      {isPending ? '...' : label}
    </button>
  )
}
