// components/CaptureImportPanel.tsx
// Manual fallback for the capture pipeline, shown on the project detail page.
//
// The normal path is `npm run capture`, which drives Chrome and posts for you.
// This panel covers the cases that path does not: a single re-do, a machine
// without Playwright, or an app that only opens in the operator's own browser.
// The operator runs the capture script by hand, hits "Salin JSON" in the
// in-page panel, and pastes the result here.
//
// Requirements: 4.2, 4.5, 4.6

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface CaptureImportPanelProps {
  projectId: string
  projectUrl: string
  categoryId: string
}

export default function CaptureImportPanel({
  projectUrl,
  categoryId,
}: CaptureImportPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [json, setJson] = useState('')
  const [message, setMessage] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  const [scriptCopied, setScriptCopied] = useState(false)

  async function copyCaptureScript() {
    try {
      const res = await fetch('/partyrock-capture.js')
      const text = await res.text()
      await navigator.clipboard.writeText(text)
      setScriptCopied(true)
      setTimeout(() => setScriptCopied(false), 4000)
    } catch {
      setMessage({
        kind: 'error',
        text: 'Failed to copy the script. Open /partyrock-capture.js in a new tab and copy it manually.',
      })
    }
  }

  function handleImport() {
    setMessage(null)

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(json)
    } catch {
      setMessage({
        kind: 'error',
        text: 'Invalid JSON — make sure the entire content was copied.',
      })
      return
    }

    // Force the payload onto this project: the address bar on PartyRock may
    // differ from the submitted URL after a rename, and the operator is
    // explicitly importing *for this row*.
    parsed.url = projectUrl
    parsed.categoryId = categoryId

    startTransition(async () => {
      try {
        const res = await fetch('/api/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        })
        const body = await res.json()

        if (!res.ok) {
          setMessage({ kind: 'error', text: body.message || 'Import failed.' })
          return
        }

        setMessage({ kind: 'ok', text: body.message || 'Capture saved.' })
        setJson('')
        router.refresh()
      } catch {
        setMessage({ kind: 'error', text: 'Network error. Please try again.' })
      }
    })
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
      <h3 className="text-sm font-semibold text-gray-900">
        Manual Capture Import
      </h3>
      <p className="mt-1 text-sm text-gray-500">
        PartyRock widgets and prompts are only visible in a logged-in browser
        session. The normal way: run{' '}
        <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
          npm run capture
        </code>
        . This panel is for a single project only.
      </p>

      <ol className="mt-4 space-y-1.5 text-sm text-gray-600 list-decimal list-inside">
        <li>
          Copy the capture script, open this project&apos;s PartyRock page, and
          paste it into the DevTools console.
        </li>
        <li>Click the widgets in that app so the AI produces output.</li>
        <li>
          Click <span className="font-medium">Copy JSON</span> in the panel at
          the bottom right.
        </li>
        <li>Paste the result into the box below, then Import.</li>
      </ol>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copyCaptureScript}
          className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200"
        >
          {scriptCopied ? 'Script copied' : 'Copy Capture Script'}
        </button>
        <a
          href={projectUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200"
        >
          Open PartyRock Page
        </a>
      </div>

      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder='{"url": "https://partyrock.aws/u/...", "widgets": [...], "prompts": [...]}'
        className="mt-4 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 font-mono text-xs transition-colors focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleImport}
          disabled={isPending || json.trim() === ''}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Importing...' : 'Import & Re-score'}
        </button>

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
