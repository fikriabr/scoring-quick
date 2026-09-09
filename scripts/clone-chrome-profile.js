#!/usr/bin/env node
/*
 * scripts/clone-chrome-profile.js
 *
 * Copies the signed-in state out of your everyday Chrome profile into the
 * capture profile (`.pr-chrome-profile/`), so `npm run capture` opens a
 * browser that is *already logged in*.
 *
 * Why bother, instead of just pointing PR_CHROME_PROFILE at the real profile?
 * -------------------------------------------------------------------------
 * Two reasons, and the first is the one that usually bites:
 *
 * 1. Google refuses OAuth sign-in in a browser it detects as automated
 *    ("This browser or app may not be secure"). So signing in *inside* the
 *    capture browser tends not to work at all. Copying an existing session
 *    sidesteps the login instead of fighting it.
 *
 * 2. Chrome holds an exclusive lock on a profile folder while it runs. Using
 *    the real folder means quitting Chrome every single capture run, and
 *    letting an automated session write to the profile you use all day.
 *
 * Only session-bearing files are copied — cookies, the encryption key, and
 * preferences — not history, cache, extensions or bookmarks. On Windows the
 * cookie encryption key is protected by DPAPI and tied to your Windows user
 * account, so the copy only decrypts as the same user on the same machine.
 * That is why `Local State` has to come along: it holds that wrapped key.
 *
 * Usage:
 *   npm run capture:clone-profile                 # clone the Default profile
 *   npm run capture:clone-profile -- "Profile 3"  # clone a named profile
 *   npm run capture:clone-profile -- --list       # show available profiles
 *
 * Chrome must be closed while this runs: it flushes cookies to disk on exit,
 * so copying from a running Chrome can capture a stale or partial database.
 */

import { copyFile, mkdir, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const TARGET_ROOT = path.join(projectRoot, '.pr-chrome-profile')

/** Default Chrome "User Data" location per platform. */
function defaultChromeRoot() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data',
    )
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  }
  return path.join(os.homedir(), '.config', 'google-chrome')
}

const SOURCE_ROOT = process.env.PR_CHROME_SOURCE_PROFILE || defaultChromeRoot()

/**
 * Files copied from the profile folder itself. Cookies moved under Network/
 * in Chrome 96; both locations are attempted so older installs still work.
 */
const PROFILE_FILES = [
  'Network/Cookies',
  'Network/Trust Tokens',
  'Cookies',
  'Preferences',
  'Secure Preferences',
  'Login Data',
  'Web Data',
]

/** Files copied from the User Data root. `Local State` holds the cookie key. */
const ROOT_FILES = ['Local State']

async function exists(target) {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Read the human-readable names Chrome shows in its profile switcher. */
async function listProfiles() {
  const localState = path.join(SOURCE_ROOT, 'Local State')
  if (!(await exists(localState))) return []
  try {
    const parsed = JSON.parse(await readFile(localState, 'utf8'))
    const cache = (parsed.profile && parsed.profile.info_cache) || {}
    return Object.keys(cache).map((dir) => ({
      dir,
      name: cache[dir].name || '(unnamed)',
      account: cache[dir].gaia_name || cache[dir].user_name || null,
    }))
  } catch {
    return []
  }
}

/** Copy one file, reporting whether it was there at all. */
async function copyIfPresent(from, to) {
  if (!(await exists(from))) return false
  await mkdir(path.dirname(to), { recursive: true })
  await copyFile(from, to)
  return true
}

async function main() {
  const args = process.argv.slice(2)

  if (!(await exists(SOURCE_ROOT))) {
    console.error(
      `Chrome user data not found at:\n  ${SOURCE_ROOT}\n\n` +
        'Set PR_CHROME_SOURCE_PROFILE to your Chrome "User Data" folder and retry.',
    )
    process.exit(1)
  }

  const profiles = await listProfiles()

  if (args.includes('--list') || args.includes('-l')) {
    console.log(`Chrome profiles in ${SOURCE_ROOT}:\n`)
    for (const profile of profiles) {
      const signedIn = profile.account ? `signed in as ${profile.account}` : 'not signed in'
      console.log(`  ${profile.dir.padEnd(12)} ${profile.name} — ${signedIn}`)
    }
    console.log('\nClone one with:  npm run capture:clone-profile -- "Profile 3"')
    return
  }

  const profileDir = args.find((a) => !a.startsWith('-')) || 'Default'
  const sourceProfile = path.join(SOURCE_ROOT, profileDir)

  if (!(await exists(sourceProfile))) {
    console.error(`No such profile folder: ${sourceProfile}`)
    console.error('Run with --list to see what is available.')
    process.exit(1)
  }

  const chosen = profiles.find((p) => p.dir === profileDir)
  console.log(`Source: ${sourceProfile}`)
  if (chosen) {
    console.log(
      `        "${chosen.name}"${chosen.account ? ` — signed in as ${chosen.account}` : ' — not signed in'}`,
    )
  }
  console.log(`Target: ${TARGET_ROOT}\n`)

  // Playwright always opens the "Default" profile of the user-data-dir it is
  // given, so whichever source profile is chosen lands there.
  const targetProfile = path.join(TARGET_ROOT, 'Default')
  await mkdir(targetProfile, { recursive: true })

  const copied = []
  const missing = []

  for (const relative of ROOT_FILES) {
    const ok = await copyIfPresent(path.join(SOURCE_ROOT, relative), path.join(TARGET_ROOT, relative))
    ;(ok ? copied : missing).push(relative)
  }

  for (const relative of PROFILE_FILES) {
    const ok = await copyIfPresent(
      path.join(sourceProfile, relative),
      path.join(targetProfile, relative),
    )
    ;(ok ? copied : missing).push(relative)
  }

  console.log(`Copied ${copied.length} file(s):`)
  for (const file of copied) console.log(`  + ${file}`)
  if (missing.length > 0) {
    console.log(`\nNot present in this profile (usually fine):`)
    for (const file of missing) console.log(`  - ${file}`)
  }

  const gotCookies = copied.some((f) => f.includes('Cookies'))
  if (!gotCookies) {
    console.log(
      '\nWarning: no cookie database was found, so the clone will not be\n' +
        'signed in. Make sure Chrome was closed, then run this again.',
    )
  } else {
    console.log(
      '\nDone. Make sure PR_CHROME_PROFILE is NOT set in .env, then run:\n' +
        '  npm run capture\n\n' +
        'The browser that opens should already be signed in. If PartyRock still\n' +
        'asks you to log in, close Chrome completely and re-run this clone —\n' +
        'Chrome only flushes cookies to disk when it exits.',
    )
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exit(1)
})
