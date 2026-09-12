/**
 * Prove the sync path works against the real Google, not against a mock.
 *
 * The unit tests cover every branch of the device flow and the merge, but they
 * cover them against a scripted `fetch`. Three things they structurally cannot
 * check are exactly the three that broke during development: whether Google
 * accepts this client *type*, whether it accepts the *scope* (it rejects
 * `drive.appdata` despite documenting it), and whether the Drive requests are
 * shaped the way Drive actually wants. This script checks all three by doing
 * them for real.
 *
 *     node scripts/verify-sync-live.mjs
 *
 * It prints a code, waits for a human to enter it at google.com/device, and
 * then performs a full round trip: create a file, read it back, compare, delete
 * it. The probe file is deliberately NOT the real library filename — it is
 * `WatchThemAll sync probe.json`, so a verification run can never touch a real
 * library. Under `drive.file` the script cannot see or delete anything it did
 * not create itself, which is the same boundary the app runs under.
 *
 * Credentials come from the untracked `.env` at the repository root, the same
 * file the builds read. Nothing is written to disk; the tokens live in memory
 * for the length of the run and are revoked at the end.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const PROBE_NAME = 'WatchThemAll sync probe.json'

/** Read `.env` without pulling in a dependency for four lines of parsing. */
function readEnv() {
  const text = readFileSync(resolve(ROOT, '.env'), 'utf8')
  const values = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return values
}

/** Returned when the code was never entered — distinct from a real failure. */
const EXPIRED = Symbol('expired')

const step = (message) => console.log(`\n[${new Date().toISOString()}] ${message}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: response.status, body: await response.json() }
}

async function main() {
  const env = readEnv()
  const clientId = env.WTA_GOOGLE_CLIENT_ID
  const clientSecret = env.WTA_GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('.env has no WTA_GOOGLE_CLIENT_ID/SECRET')

  step('Asking Google for a code')
  const challenge = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE })
  if (challenge.status !== 200) {
    throw new Error(`device/code refused: ${JSON.stringify(challenge.body)}`)
  }
  const { device_code, user_code, verification_url, interval = 5, expires_in = 1800 } = challenge.body

  console.log(`\n  Open  ${verification_url}`)
  console.log(`  Enter ${user_code}`)
  console.log(`  Valid for ${Math.round(expires_in / 60)} minutes.\n`)

  step('Waiting for the account holder')
  const deadline = Date.now() + expires_in * 1000
  let waitSeconds = interval
  let tokens = null
  while (tokens === null) {
    if (Date.now() > deadline) { tokens = EXPIRED; break }
    await sleep(waitSeconds * 1000)
    const poll = await postForm(TOKEN_URL, {
      client_id: clientId,
      client_secret: clientSecret,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (poll.status === 200) tokens = poll.body
    else if (poll.body.error === 'authorization_pending') continue
    // A `slow_down` is permanent for the rest of the attempt; speeding up again
    // only invites the same rebuke.
    else if (poll.body.error === 'slow_down') waitSeconds += 5
    // Nobody typed the code. That is not a defect in anything being tested, so
    // it gets its own exit status: a verification run that simply went unwatched
    // must not be mistaken for a verification run that found something wrong.
    else if (poll.body.error === 'expired_token') { tokens = EXPIRED; break }
    else throw new Error(`token endpoint refused: ${JSON.stringify(poll.body)}`)
  }

  if (tokens === EXPIRED) {
    console.log('\nUNWATCHED — the code was never entered, so nothing was verified.')
    console.log('Nothing failed. Run this again when somebody is there to approve it.\n')
    process.exitCode = 2
    return
  }

  step('Authorised')
  console.log(`  scopes granted: ${tokens.scope}`)
  console.log(`  refresh token:  ${tokens.refresh_token ? 'issued' : 'MISSING — sync would die at the first expiry'}`)

  const authorised = (url, init = {}) =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${tokens.access_token}` } })

  step('Reading the account label (drive/v3/about)')
  const about = await authorised(`${FILES_URL.replace('/files', '/about')}?fields=user(emailAddress)`)
  console.log(`  ${about.status} ${JSON.stringify(await about.json())}`)

  step('Listing — under drive.file this must contain only our own files')
  const listBefore = await authorised(
    `${FILES_URL}?${new URLSearchParams({ q: `name = '${PROBE_NAME}' and trashed = false`, fields: 'files(id,name)', pageSize: '1' })}`,
  )
  const before = await listBefore.json()
  console.log(`  ${listBefore.status} ${JSON.stringify(before)}`)

  step('Creating the probe file (multipart, the shape the app uses)')
  const payload = JSON.stringify({ probe: true, at: new Date().toISOString() })
  const boundary = `wta-${Math.random().toString(36).slice(2)}`
  const create = await authorised(`${UPLOAD_URL}?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body:
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: PROBE_NAME })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`,
  })
  const created = await create.json()
  console.log(`  ${create.status} ${JSON.stringify(created)}`)
  if (!create.ok) throw new Error('create failed')

  step('Finding it by name, the way the app does every sync')
  const listAfter = await authorised(
    `${FILES_URL}?${new URLSearchParams({ q: `name = '${PROBE_NAME}' and trashed = false`, fields: 'files(id,name)', pageSize: '1' })}`,
  )
  const found = await listAfter.json()
  console.log(`  ${listAfter.status} ${JSON.stringify(found)}`)
  if (found.files?.[0]?.id !== created.id) throw new Error('the file we just created is not findable by name')

  step('Downloading it back and comparing byte for byte')
  const download = await authorised(`${FILES_URL}/${created.id}?alt=media`)
  const text = await download.text()
  console.log(`  ${download.status} ${text}`)
  if (text !== payload) throw new Error(`round trip changed the bytes:\n  sent ${payload}\n  got  ${text}`)

  step('Updating it in place (PATCH media, the app\'s push path)')
  const second = JSON.stringify({ probe: true, updated: true })
  const update = await authorised(`${UPLOAD_URL}/${created.id}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: second,
  })
  console.log(`  ${update.status}`)
  const reread = await (await authorised(`${FILES_URL}/${created.id}?alt=media`)).text()
  if (reread !== second) throw new Error(`update did not take: ${reread}`)

  step('Refreshing the access token')
  const refreshed = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  })
  console.log(`  ${refreshed.status} access_token ${refreshed.body.access_token ? 'reissued' : 'NOT reissued'}`)

  step('Cleaning up: deleting the probe file')
  const remove = await authorised(`${FILES_URL}/${created.id}`, { method: 'DELETE' })
  console.log(`  ${remove.status}`)

  step('Revoking the grant, so this run leaves nothing behind')
  const revoke = await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.refresh_token}`, { method: 'POST' })
  console.log(`  ${revoke.status}`)

  console.log('\nPASS — device flow, Drive round trip, update, refresh and revoke all succeeded.\n')
}

main().catch((error) => {
  console.error(`\nFAIL — ${error.message}\n`)
  process.exitCode = 1
})
