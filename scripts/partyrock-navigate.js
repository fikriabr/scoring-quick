#!/usr/bin/env node
/*
 * scripts/partyrock-navigate.js
 *
 * Navigation automation — deliberately NOT interaction automation.
 *
 * What it automates
 * -----------------
 * Opening each submitted PartyRock URL in a real, visible Chrome window and
 * injecting `public/partyrock-capture.js`. That is the boring part: with 30
 * to 100 submissions, opening and closing tabs by hand is where the time goes.
 *
 * What stays manual, on purpose
 * -----------------------------
 * Clicking widgets to trigger AI generation. That needs a semantic reading of
 * each app — which widget produces the output worth judging differs per app,
 * and no selector generalises across them. It is also exactly the human
 * presence that keeps the session ordinary: this script never calls a
 * WAF-protected endpoint, never replays an internal API, and never drives a
 * widget. It opens pages a logged-in human then uses normally.
 *
 * That split is what keeps the risk low. Everything this script touches is
 * page navigation; everything the WAF actually guards is left to the human.
 *
 * Usage
 * -----
 *   npm run capture                      # every project still missing widgets
 *   npm run capture -- --url <url>       # exactly one submitted project
 *   npm run capture -- --all             # including already-captured ones
 *   npm run capture -- --category <id>   # one category only
 *   npm run capture -- --limit 10        # first 10 of the queue
 *   npm run capture -- --urls list.txt   # explicit URL list, one per line
 *
 * Environment (.env)
 * ------------------
 *   CAPTURE_TOKEN       shared secret, must match the running app
 *   APP_BASE_URL        optional. Without it the script uses the Vercel domain
 *                       (VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL) when those
 *                       are present, otherwise http://localhost:3000. Override
 *                       per run with --base-url.
 *   PR_CHROME_PROFILE   Chrome user-data-dir to reuse. Defaults to a
 *                       dedicated folder in this repo so your everyday Chrome
 *                       profile is never locked or modified. Point it at your
 *                       real profile only if you understand that Chrome must
 *                       be fully closed first.
 */

import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

dotenv.config({ path: path.join(projectRoot, '.env') })

const CAPTURE_SCRIPT = path.join(projectRoot, 'public', 'partyrock-capture.js')
const DEFAULT_PROFILE_DIR = path.join(projectRoot, '.pr-chrome-profile')

const CAPTURE_TOKEN = (process.env.CAPTURE_TOKEN || '').trim()
const PROFILE_DIR = process.env.PR_CHROME_PROFILE || DEFAULT_PROFILE_DIR

/**
 * Which profile inside the user-data-dir to open, e.g. "Default" or
 * "Profile 3". Chrome keeps every profile under one user-data-dir and picks
 * between them with --profile-directory; without this, a real User Data
 * folder always opens as "Default", which may not be the signed-in one.
 */
const PROFILE_NAME = (process.env.PR_CHROME_PROFILE_DIR || '').trim()

const usingRealProfile = PROFILE_DIR !== DEFAULT_PROFILE_DIR

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    all: false,
    category: null,
    limit: null,
    url: null,
    urlGiven: false,
    urls: null,
    baseUrl: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') args.all = true
    else if (arg === '--category') args.category = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    // Presence is tracked separately from the value: `--url` with an empty or
    // missing value must fail loudly, not fall through to the full queue and
    // silently open every project.
    else if (arg === '--url') {
      args.urlGiven = true
      args.url = argv[++i] ?? ''
    } else if (arg === '--urls') args.urls = argv[++i]
    else if (arg === '--base-url') args.baseUrl = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Where to reach the app
// ---------------------------------------------------------------------------

/**
 * Resolve the app's base URL without hardcoding a host.
 *
 * Order: explicit --base-url, then APP_BASE_URL, then the Vercel system
 * variables (VERCEL_PROJECT_PRODUCTION_URL is the stable production domain;
 * VERCEL_URL is the per-deployment one, both bare hostnames), then localhost.
 * The Vercel entries only exist when they were pulled into .env — e.g. via
 * `vercel env pull` with "Automatically expose System Environment Variables"
 * enabled — so a purely local run still falls through to localhost.
 */
function resolveAppBaseUrl(override) {
  const explicit = (override || process.env.APP_BASE_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const vercelHost = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    ''
  ).trim()
  if (vercelHost) {
    // Vercel exposes these as bare hostnames, without a scheme.
    return /^https?:\/\//.test(vercelHost)
      ? vercelHost.replace(/\/+$/, '')
      : `https://${vercelHost}`
  }

  return `http://localhost:${process.env.PORT || 3000}`
}

const APP_BASE_URL = resolveAppBaseUrl(args.baseUrl)

if (args.help) {
  console.log(
    [
      'Usage: npm run capture -- [options]',
      '',
      '  --url <url>        capture exactly one submitted project by its URL',
      '                     (resolved against the queue, so a URL that was',
      '                     never submitted fails before Chrome opens)',
      '  --all              include projects that already have captured widgets',
      '  --category <id>    restrict to one category',
      '  --limit <n>        stop after n projects',
      '  --urls <file>      use a text file of URLs instead of the app queue',
      '  --base-url <url>   target app, e.g. https://your-app.vercel.app',
      '                     (defaults to APP_BASE_URL, then the Vercel domain,',
      '                     then http://localhost:3000)',
    ].join('\n'),
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Worklist
// ---------------------------------------------------------------------------

/**
 * Is a Chrome process already running?
 *
 * Only used to produce a clear message before launching against a real
 * profile — a false negative just falls through to Playwright's own error.
 */
async function isChromeRunning() {
  const { exec } = await import('node:child_process')
  const command =
    process.platform === 'win32'
      ? 'tasklist /FI "IMAGENAME eq chrome.exe" /NH'
      : 'pgrep -x "Google Chrome" || pgrep -x chrome'

  return new Promise((resolve) => {
    exec(command, (error, stdout) => {
      if (error) return resolve(false)
      resolve(/chrome/i.test(stdout || ''))
    })
  })
}

/**
 * Comparable identities for one PartyRock URL.
 *
 * Mirrors `normalizeUrl` and `extractAppId` in lib/services/capture.service.ts.
 * The logic is duplicated rather than imported because that module is
 * TypeScript and pulls in the Prisma client, neither of which this plain-Node
 * script can load. Keep the two in step if the matching rules change.
 *
 *   normalized  lowercase host, no query, no hash, no trailing slash
 *   appId       the `{appId}` segment of /u/{user}/{appId}/{App-Name}, which
 *               survives the participant renaming their app
 */
function urlMatchKeys(url) {
  const trimmed = (url || '').trim()
  let normalized = trimmed.replace(/\/+$/, '')
  let appId = null

  try {
    const parsed = new URL(trimmed)
    normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`

    const segments = parsed.pathname.split('/').filter(Boolean)
    const uIndex = segments.indexOf('u')
    // Need at least `u/{user}/{appId}`
    if (uIndex !== -1 && segments.length >= uIndex + 3)
      appId = segments[uIndex + 2]
  } catch {
    // Not a parseable URL — fall back to the trimmed string for normalized.
  }

  return { normalized, appId }
}

/**
 * Build a one-item worklist for a single project, given its URL.
 *
 * Unlike `--urls`, this resolves the URL against the app's own queue instead
 * of trusting it blindly. That matters because the capture is only accepted if
 * the URL matches a submission: checking now turns a wasted session (open the
 * app, click every widget, then get NO_MATCHING_PROJECT) into an error before
 * Chrome even launches.
 *
 * Matching is the same two-pass rule the server uses — exact normalised URL
 * first, then app id — so an app renamed on PartyRock still resolves.
 */
async function resolveSingleProject(rawUrl) {
  const target = (rawUrl || '').trim()
  if (!target) {
    throw new Error(
      '--url needs a PartyRock URL, e.g.\n  npm run capture -- --url https://partyrock.aws/u/user/appid/App-Name',
    )
  }

  // `--all`: a targeted single capture is almost always a redo of an app that
  // already has data, so the pending-only filter would hide the very project
  // that was asked for.
  const projects = await fetchQueue({ all: true, category: args.category })

  const wanted = urlMatchKeys(target)
  let matches = projects.filter(
    (p) => urlMatchKeys(p.url).normalized === wanted.normalized,
  )

  if (matches.length === 0 && wanted.appId) {
    matches = projects.filter((p) => urlMatchKeys(p.url).appId === wanted.appId)
    if (matches.length > 0) {
      console.log(
        'Matched by app id — the submitted URL differs from the one given.',
      )
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No submission matches ${target}\n\n` +
        'Capture is only stored against a URL that was already submitted.\n' +
        'Submit it first in Admin → Submissions, or check for a typo.\n' +
        `The app currently has ${projects.length} submission(s)` +
        (args.category ? ' in that category.' : '.'),
    )
  }

  const first = matches[0]

  // The same app submitted to several categories should receive the capture in
  // all of them. The server already fans out that way when no categoryId is
  // given, so only pin the category when the match is unambiguous.
  if (matches.length > 1) {
    console.log(
      `This app is submitted to ${matches.length} categories ` +
        `(${matches.map((m) => m.categoryName).join(', ')}).\n` +
        'One tab opens, and the capture is saved to all of them.',
    )
    return [
      {
        url: first.url,
        participantName: first.participantName,
        categoryName: `${matches.length} categories`,
      },
    ]
  }

  return [
    {
      url: first.url,
      participantName: first.participantName,
      categoryName: first.categoryName,
      categoryId: first.categoryId,
    },
  ]
}

/** GET the project list from the running app. */
async function fetchQueue({ all, category }) {
  const params = new URLSearchParams()
  if (!all) params.set('pending', '1')
  if (category) params.set('categoryId', category)

  const endpoint = `${APP_BASE_URL}/api/capture/queue?${params.toString()}`
  let response
  try {
    response = await fetch(endpoint, {
      headers: { 'X-Capture-Token': CAPTURE_TOKEN },
    })
  } catch (error) {
    throw new Error(
      `Could not reach ${endpoint}. Is the dev server running (npm run dev)?\n  ${error.message}`,
    )
  }

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `Queue request failed (HTTP ${response.status}): ${body.message || ''}`,
    )
  }

  return body.projects || []
}

/** Read the queue from the running app, or from a plain URL file. */
async function loadQueue() {
  if (args.urlGiven) return resolveSingleProject(args.url)

  if (args.urls) {
    const raw = await readFile(path.resolve(process.cwd(), args.urls), 'utf8')
    const urls = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    return urls.map((url) => ({
      url,
      participantName: '(from file)',
      categoryName: '—',
    }))
  }

  return fetchQueue({ all: args.all, category: args.category })
}

/** POST one capture payload to the scoring app. */
async function postCapture(payload) {
  const response = await fetch(`${APP_BASE_URL}/api/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Capture-Token': CAPTURE_TOKEN,
    },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!CAPTURE_TOKEN) {
    console.error(
      'CAPTURE_TOKEN is not set in .env.\n' +
        'Generate one and add it to both .env and your shell, e.g.\n' +
        '  CAPTURE_TOKEN="' +
        Math.random().toString(36).slice(2) +
        Date.now().toString(36) +
        '"',
    )
    process.exit(1)
  }

  if (!existsSync(CAPTURE_SCRIPT)) {
    console.error(`Capture script not found at ${CAPTURE_SCRIPT}`)
    process.exit(1)
  }

  let queue = await loadQueue()
  if (args.limit && Number.isFinite(args.limit))
    queue = queue.slice(0, args.limit)

  if (queue.length === 0) {
    console.log('Nothing to capture — every project already has widget data.')
    console.log(
      'Run with --all to revisit projects that were already captured.',
    )
    return
  }

  console.log(`\n${queue.length} project(s) to visit.`)
  console.log(`App: ${APP_BASE_URL}`)
  console.log(
    `Chrome profile: ${PROFILE_DIR}${PROFILE_NAME ? ` (${PROFILE_NAME})` : ''}`,
  )

  if (usingRealProfile) {
    // Chrome holds an exclusive lock on a user-data-dir while it runs, so a
    // real profile cannot be shared with an open Chrome window. Failing here
    // with an explanation beats Playwright's opaque "Target closed".
    if (await isChromeRunning()) {
      throw new Error(
        'Chrome is already running, and PR_CHROME_PROFILE points at a real\n' +
          'Chrome profile. Chrome locks its profile folder while open.\n\n' +
          'Close every Chrome window (check the tray, and Task Manager for\n' +
          'leftover chrome.exe) and run npm run capture again.\n\n' +
          'To avoid closing Chrome each time, clone the profile instead:\n' +
          '  npm run capture:clone-profile\n' +
          'then remove PR_CHROME_PROFILE from .env.',
      )
    }
  } else {
    console.log('First run: sign in to PartyRock in the window that opens. The')
    console.log(
      'session persists in that folder, so later runs skip the login.',
    )
    console.log('If Google refuses to sign in there, see docs/CAPTURE.md —')
    console.log('cloning your real profile avoids the login entirely.\n')
  }

  const launchArgs = ['--start-maximized']
  if (PROFILE_NAME) launchArgs.push(`--profile-directory=${PROFILE_NAME}`)

  let context
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: launchArgs,
    })
  } catch (error) {
    throw new Error(
      `Could not launch Chrome with profile "${PROFILE_DIR}".\n  ${error.message.split('\n')[0]}\n\n` +
        'If Chrome is installed somewhere unusual, or this is a real profile\n' +
        'that is still locked, see docs/CAPTURE.md.',
    )
  }

  // Injected before any page script runs, so the in-page fetch/XHR hooks are
  // installed in time to observe the app definition request.
  await context.addInitScript(
    ({ apiUrl, token }) => {
      window.__PR_CAPTURE_CONFIG = { apiUrl, token, postFromPage: false }
    },
    { apiUrl: `${APP_BASE_URL}/api/capture`, token: CAPTURE_TOKEN },
  )
  await context.addInitScript({ path: CAPTURE_SCRIPT })

  const summary = { sent: 0, skipped: 0, failed: 0, noMatch: 0 }

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    const position = `[${i + 1}/${queue.length}]`
    console.log(`\n${position} ${item.participantName} — ${item.categoryName}`)
    console.log(`        ${item.url}`)

    const page = await context.newPage()

    // Browser-level safety net: some JSON never passes through the page's own
    // fetch/XHR (service worker, preloads). Anything seen here is pushed into
    // the page so one set of extraction walkers handles everything.
    page.on('response', async (response) => {
      try {
        const contentType = response.headers()['content-type'] || ''
        if (!contentType.includes('json')) return
        const body = await response.json()
        await page.evaluate(
          ([url, parsed]) => {
            if (typeof window.__prCaptureIngest === 'function') {
              window.__prCaptureIngest(url, parsed)
            }
          },
          [response.url(), body],
        )
      } catch {
        // Response already consumed, navigated away, or not really JSON.
      }
    })

    try {
      await page.goto(item.url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
    } catch (error) {
      console.log(`        Could not open the page: ${error.message}`)
      summary.failed++
      await page.close().catch(() => {})
      continue
    }

    // A real Chrome profile restores its previous session on launch, so the
    // automation tab can end up behind the windows the user already had open —
    // looking exactly like "the URL never opened". Raise it explicitly.
    await page.bringToFront().catch(() => {})

    // Report where the tab actually landed. PartyRock redirects to a sign-in
    // page when the session is not valid, and that redirect is otherwise
    // invisible from the terminal.
    const landedUrl = page.url()
    if (!/(^|\.)partyrock\.aws$/.test(new URL(landedUrl).hostname)) {
      console.log(`        Redirected off PartyRock → ${landedUrl}`)
      console.log('        (usually a sign-in wall — see docs/CAPTURE.md)')
    } else if (landedUrl !== item.url) {
      console.log(`        Opened as ${landedUrl}`)
    }

    console.log('        Click the widgets to generate output, then press')
    console.log('        "Kirim & Lanjut" in the panel (bottom right).')

    let state = 'skipped'
    try {
      // No timeout: the human decides when this app is done.
      await page.waitForFunction(() => window.__PR_CAPTURE_STATE !== '', null, {
        timeout: 0,
      })
      state = await page.evaluate(() => window.__PR_CAPTURE_STATE)
    } catch (error) {
      console.log(
        `        Page closed before capture (${error.message.split('\n')[0]}).`,
      )
      summary.skipped++
      await page.close().catch(() => {})
      continue
    }

    if (state === 'skipped') {
      console.log('        Skipped.')
      summary.skipped++
      await page.close().catch(() => {})
      continue
    }

    let payload
    try {
      payload = await page.evaluate(() => window.__partyRockCapture())
    } catch (error) {
      console.log(`        Could not read the capture: ${error.message}`)
      summary.failed++
      await page.close().catch(() => {})
      continue
    }

    // Keep the submitted URL as the identity: PartyRock rewrites the address
    // bar (app rename, share redirect) and the payload URL may no longer match
    // what the participant submitted.
    if (item.url) payload.url = item.url
    if (item.categoryId) payload.categoryId = item.categoryId

    const result = await postCapture(payload)
    if (result.ok) {
      console.log(
        `        Saved — ${payload.widgets.length} widget, ` +
          `${payload.prompts.length} prompt, ${payload.outputs.length} output. Scoring started.`,
      )
      summary.sent++
    } else if (result.body?.code === 'NO_MATCHING_PROJECT') {
      console.log(`        ${result.body.message}`)
      summary.noMatch++
    } else {
      console.log(
        `        Failed (HTTP ${result.status}): ${result.body?.message || ''}`,
      )
      summary.failed++
    }

    await page.close().catch(() => {})
  }

  console.log(
    `\nDone. ${summary.sent} sent, ${summary.skipped} skipped, ` +
      `${summary.failed} failed, ${summary.noMatch} without a matching submission.`,
  )
  console.log('Leave the browser open to keep the session, or close it now.')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  await new Promise((resolve) =>
    rl.question('Press Enter to close the browser... ', resolve),
  )
  rl.close()

  await context.close()
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exit(1)
})
