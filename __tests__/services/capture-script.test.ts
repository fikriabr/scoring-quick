/**
 * Tests for `public/partyrock-capture.js` — the script that runs inside a
 * PartyRock page.
 *
 * **Validates: Requirements 4.2, 4.5**
 *
 * This script is the only part of the pipeline that cannot be exercised from
 * the app itself, and it is the part most likely to silently return nothing:
 * it has to find widgets in JSON whose shape Amazon does not document. So it
 * is loaded here into a minimal DOM stub and fed realistic payloads.
 *
 * The stub is deliberately thin — just enough surface for the script to
 * install and run. Anything it does not implement returns empty, which also
 * proves the script degrades quietly instead of throwing on an unfamiliar page.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const SCRIPT_PATH = path.join(process.cwd(), 'public', 'partyrock-capture.js')
const scriptSource = readFileSync(SCRIPT_PATH, 'utf8')

type CaptureWindow = {
  __partyRockCapture: () => {
    url: string
    title: string | null
    description: string | null
    widgets: { type: string; label: string }[]
    prompts: string[]
    outputs: string[]
    appDefinition: unknown
    source: string
  }
  __prCaptureIngest: (url: string, body: unknown) => void
  __PR_CAPTURE_STATE: string
}

/** Minimal DOM surface: enough for the script to install and read the page. */
function createSandbox(): CaptureWindow {
  const noopElement = {
    style: {},
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    innerText: '',
    textContent: '',
  }

  const documentStub = {
    readyState: 'complete',
    title: 'Stub App',
    documentElement: { appendChild: () => {} },
    createElement: () => ({ ...noopElement, onclick: null }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  }

  const windowStub: Record<string, unknown> = {
    location: { href: 'https://partyrock.aws/u/tester/app123/Stub-App' },
    document: documentStub,
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    Date,
    JSON,
    WeakSet,
    console,
  }
  windowStub.window = windowStub

  const context = vm.createContext(windowStub)
  vm.runInContext(scriptSource, context)

  return windowStub as unknown as CaptureWindow
}

let win: CaptureWindow

beforeEach(() => {
  win = createSandbox()
})

describe('partyrock-capture.js — installation', () => {
  it('installs on a page it knows nothing about without throwing', () => {
    expect(typeof win.__partyRockCapture).toBe('function')
    const data = win.__partyRockCapture()
    expect(data.url).toBe('https://partyrock.aws/u/tester/app123/Stub-App')
    expect(data.widgets).toEqual([])
    expect(data.prompts).toEqual([])
  })

  it('starts with an empty state signal so the navigator waits for the human', () => {
    expect(win.__PR_CAPTURE_STATE).toBe('')
  })
})

describe('partyrock-capture.js — widget extraction from observed JSON', () => {
  it('finds widget-shaped objects regardless of where they sit in the tree', () => {
    win.__prCaptureIngest('https://partyrock.aws/api/app', {
      data: {
        app: {
          definition: {
            widgets: [
              { id: 'w1', type: 'text-input', title: 'Ingredients' },
              { id: 'w2', type: 'ai-text', title: 'Recipe', promptTemplate: 'Use {{Ingredients}}' },
            ],
          },
        },
      },
    })

    const data = win.__partyRockCapture()
    expect(data.widgets).toEqual(
      expect.arrayContaining([
        { type: 'text-input', label: 'Ingredients' },
        { type: 'ai-text', label: 'Recipe' },
      ]),
    )
    expect(data.prompts).toContain('Use {{Ingredients}}')
    expect(data.source).toBe('network')
  })

  it('handles a widget map keyed by id, not just an array', () => {
    win.__prCaptureIngest('https://partyrock.aws/api/app', {
      widgets: {
        abc: { widgetType: 'image-generation', name: 'Poster' },
        def: { widgetType: 'chatbot', name: 'Helper' },
      },
    })

    const data = win.__partyRockCapture()
    expect(data.widgets).toEqual(
      expect.arrayContaining([
        { type: 'image-generation', label: 'Poster' },
        { type: 'chatbot', label: 'Helper' },
      ]),
    )
  })

  /**
   * `{"type": "string"}` appears throughout JSON schemas and API envelopes.
   * Counting those as widgets would inflate widgetCount on every app and make
   * the "did this capture work?" signal useless.
   */
  it('does not mistake bare schema type fields for widgets', () => {
    win.__prCaptureIngest('https://partyrock.aws/api/meta', {
      schema: {
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      },
    })

    expect(win.__partyRockCapture().widgets).toEqual([])
  })

  it('deduplicates identical widgets seen across several responses', () => {
    const payload = { widgets: [{ type: 'ai-text', title: 'Recipe' }] }
    win.__prCaptureIngest('https://partyrock.aws/api/app', payload)
    win.__prCaptureIngest('https://partyrock.aws/api/app?retry=1', {
      widgets: [{ type: 'ai-text', title: 'Recipe' }],
    })

    expect(win.__partyRockCapture().widgets).toEqual([
      { type: 'ai-text', label: 'Recipe' },
    ])
  })

  it('collects prompt-shaped strings under any prompt-like key', () => {
    win.__prCaptureIngest('https://partyrock.aws/api/app', {
      widgets: [
        { type: 'ai-text', name: 'A', prompt: 'First prompt' },
        { type: 'ai-text', name: 'B', instructions: 'Second prompt' },
        { type: 'ai-text', name: 'C', systemMessage: 'Third prompt' },
      ],
    })

    const prompts = win.__partyRockCapture().prompts
    expect(prompts).toEqual(
      expect.arrayContaining(['First prompt', 'Second prompt', 'Third prompt']),
    )
  })

  it('survives a self-referencing payload instead of hanging', () => {
    const cyclic: Record<string, unknown> = {
      widgets: [{ type: 'ai-text', title: 'Loop' }],
    }
    cyclic.self = cyclic

    win.__prCaptureIngest('https://partyrock.aws/api/app', cyclic)

    expect(win.__partyRockCapture().widgets).toEqual([
      { type: 'ai-text', label: 'Loop' },
    ])
  })

  it('ignores non-object payloads', () => {
    win.__prCaptureIngest('https://partyrock.aws/api/ping', 'pong')
    win.__prCaptureIngest('https://partyrock.aws/api/ping', null)
    expect(win.__partyRockCapture().widgets).toEqual([])
  })
})
