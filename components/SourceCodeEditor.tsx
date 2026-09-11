// components/SourceCodeEditor.tsx
// Post-submit Source Code editor, shown on the project detail page.
//
// This is the escape hatch for a project whose URL the crawler cannot fetch.
// Saving posts to `PATCH /api/submissions/[id]`, which stores the value, flips
// `scoreStatus` to PENDING and re-triggers scoring.

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
// Prisma-free module: the constant cannot come from `@/lib/validators/schemas`,
// which imports the Prisma enums as values and would pull the Prisma runtime
// into the client bundle.
import { MAX_SOURCE_CODE_LENGTH } from '@/lib/validators/source-code-rules'

const COPY = {
  help: "Fill in the page's HTML markup. Used when the project URL cannot be fetched, and replaces the crawled markup.",
  placeholder: "Paste the page's HTML markup here...",
}

interface SourceCodeEditorProps {
  projectId: string
  /** Current column value. `null` when nothing has been stored yet. */
  sourceCode: string | null
}

export default function SourceCodeEditor({
  projectId,
  sourceCode,
}: SourceCodeEditorProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // The stored value, normalised to the empty string so the textarea stays
  // controlled. Kept as its own state (rather than read off the prop) so the
  // "unchanged" comparison below still works between the successful PATCH and
  // the moment `router.refresh()` delivers fresh props.
  const [saved, setSaved] = useState(sourceCode ?? '')
  const [draft, setDraft] = useState(sourceCode ?? '')
  const [message, setMessage] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const copy = COPY
  const isUnchanged = draft === saved
  const isTooLong = draft.length > MAX_SOURCE_CODE_LENGTH

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setMessage(null)

    if (file.size > MAX_SOURCE_CODE_LENGTH) {
      setMessage({
        kind: 'error',
        text: `File is too large — must not exceed ${MAX_SOURCE_CODE_LENGTH.toLocaleString()} characters.`,
      })
      return
    }

    try {
      const text = await file.text()
      if (text.length > MAX_SOURCE_CODE_LENGTH) {
        setMessage({
          kind: 'error',
          text: `File content must not exceed ${MAX_SOURCE_CODE_LENGTH.toLocaleString()} characters.`,
        })
        return
      }
      setDraft(text)
      setFileName(file.name)
    } catch {
      setMessage({
        kind: 'error',
        text: 'Could not read the selected file. Please try again.',
      })
    }
  }

  function handleSave() {
    setMessage(null)

    startTransition(async () => {
      try {
        const res = await fetch(`/api/submissions/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Blank input is sent as `null` rather than `''`: an empty column is
          // "no evidence", which is what the scorer and the indicator below
          // both read. The server normalises whitespace-only input the same
          // way, so the two agree.
          body: JSON.stringify({
            sourceCode: draft.trim() === '' ? null : draft,
          }),
        })

        // Not every failure carries a JSON body (a proxy 502, an HTML error
        // page), so parsing is allowed to fail without masking the status.
        const body = await res.json().catch(() => null)

        if (!res.ok) {
          setMessage({ kind: 'error', text: errorText(res.status, body) })
          return
        }

        // Response shape: { id, sourceCode, scoreStatus }. Trust the server's
        // normalised value over the local draft, so the counter and the
        // indicator show what is actually stored.
        const stored: string =
          typeof body?.sourceCode === 'string' ? body.sourceCode : ''
        setSaved(stored)
        setDraft(stored)
        setMessage({
          kind: 'ok',
          text: 'Source Code saved. The AI Score is being updated — reload in a moment to see the results.',
        })
        router.refresh()
      } catch {
        setMessage({ kind: 'error', text: 'Network error. Please try again.' })
      }
    })
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">Source Code</h3>
        {/* Availability + size indicator, for both project types.
            Requirements: 5.6 */}
        {saved.length > 0 ? (
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            available ({saved.length.toLocaleString()} characters)
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
            not set (0 characters)
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-500">
        {copy.help} Saving changes re-triggers AI scoring.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label
          htmlFor="sourceCodeFileEditor"
          className="cursor-pointer rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
        >
          Upload HTML file...
        </label>
        <input
          id="sourceCodeFileEditor"
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

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setFileName(null)
        }}
        rows={10}
        spellCheck={false}
        maxLength={MAX_SOURCE_CODE_LENGTH}
        placeholder={copy.placeholder}
        className="mt-4 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 font-mono text-xs transition-colors focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      />

      <div className="mt-1.5 flex justify-end text-xs text-gray-400">
        <p
          className={`shrink-0 tabular-nums ${isTooLong ? 'text-red-600' : ''}`}
        >
          {draft.length.toLocaleString()} /{' '}
          {MAX_SOURCE_CODE_LENGTH.toLocaleString()}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          // Disabled while unchanged: saving an identical value would reset the
          // AI score to PENDING and burn an AI call for no new evidence. An
          // admin who wants a plain re-score has the separate "Retry Score"
          // button on this page, which does exactly that without touching the
          // column.
          disabled={isPending || isUnchanged || isTooLong}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving...' : 'Save & Re-score'}
        </button>

        {draft !== saved && !isPending && (
          <button
            type="button"
            onClick={() => {
              setDraft(saved)
              setMessage(null)
            }}
            className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200"
          >
            Discard Changes
          </button>
        )}

        {message && (
          <span
            className={`text-sm ${message.kind === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Turns a failed PATCH into a message an admin can act on.
 *
 * The endpoint's own `message` is preferred — it is the most specific text
 * available, and for a 400 it names the actual validation problem. The
 * per-status fallbacks exist because a response without a usable body must
 * still say what went wrong rather than degrade to a generic "failed".
 */
function errorText(status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: unknown }).message
      : undefined

  if (typeof message === 'string' && message.trim() !== '') {
    if (status === 403) return `Access denied: ${message}`
    if (status === 404) return `Project not found: ${message}`
    return message
  }

  switch (status) {
    case 400:
      return 'Invalid Source Code — check its length and try again.'
    case 403:
      return 'Access denied. Only Admins may modify Source Code.'
    case 404:
      return 'Project not found. It may have been deleted — reload the page.'
    case 429:
      return 'Too many requests. Please wait a moment and try again.'
    default:
      return `Failed to save (HTTP ${status}).`
  }
}
