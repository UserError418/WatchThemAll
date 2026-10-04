/**
 * The library, in the user's own Drive, where we cannot see anything else.
 *
 * Under `drive.file` this app can only ever touch files it created itself.
 * Everything else in the user's Drive is invisible to it — not merely
 * off-limits by policy, but absent from every listing it can make. The file
 * counts against their quota, not ours; WatchThemAll stores nothing anywhere.
 *
 * The one visible consequence, and it is worth stating plainly: the library
 * file **appears in the user's Drive**, where they can see, move or delete it.
 * The hidden alternative — `drive.appdata` — is documented as available to this
 * sign-in flow and is rejected by it in practice; `devicecode.ts` records the
 * measurement. Visible is arguably the more honest arrangement anyway: a file
 * the user can find is one they can delete without taking our word for it.
 *
 * The API surface used here is three calls: list, download, upload. That is
 * deliberate; the less of Drive this depends on, the easier it is to put a
 * second backend behind the same interface.
 */

import type { StoreDocument } from '../store/document'
import type { RemoteDocument, SyncBackend } from './types'
import type { FetchLike } from './devicecode'

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

/**
 * The filename in the user's Drive.
 *
 * They will see this, so it says what it is rather than being a slug. It is
 * also what a future migration would key on, hence a constant rather than a
 * literal at three call sites.
 */
export const DOCUMENT_NAME = 'WatchThemAll library.json'

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'DriveError'
  }
}

/** Raised when Drive rejects the credential, so the caller can re-authorise. */
export class DriveUnauthorized extends DriveError {}

/** The user's Drive has no room for the file. Signing in again cannot help with that. */
export class DriveFull extends DriveError {}

/**
 * Drive is up but not taking requests just now: one of its rate limits, a 429
 * or a server error. Worth trying again shortly, and nothing for the user to do.
 */
export class DriveBusy extends DriveError {}

/** Drive's 403 reasons that mean "not now" rather than "not you". */
const RATE_LIMITS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded'])

/** The pause before the one more try a busy Drive gets. */
const RETRY_DELAY_MS = 2_000

const SIGN_IN_AGAIN = 'Drive refused the credential; sign in again to resume syncing.'
const DRIVE_FULL = 'Your Google Drive is full, so the library cannot be saved there. Free up some space and syncing carries on by itself.'
const DRIVE_BUSY = 'Google Drive is busy right now; WatchThemAll will try again in a minute.'

/** The reason Drive gives in an error body (`error.errors[0].reason`), or null. */
async function refusalReason(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error?: { errors?: Array<{ reason?: unknown }> } } | null
  const reason = body?.error?.errors?.[0]?.reason
  return typeof reason === 'string' ? reason : null
}

/**
 * The error a response that is not ok stands for.
 *
 * A 403 is told apart by its reason. Every 401 and 403 used to read "sign in
 * again", but Drive answers 403 for a full Drive and for its rate limits as
 * well, and signing in again helps with neither: with a full Drive the user
 * went round in circles while the library stopped syncing.
 */
async function refusal(response: Response, url: string): Promise<DriveError> {
  if (response.status === 401) return new DriveUnauthorized(SIGN_IN_AGAIN, 401)
  if (response.status === 403) {
    const reason = await refusalReason(response)
    if (reason === 'storageQuotaExceeded') return new DriveFull(DRIVE_FULL, 403)
    if (reason !== null && RATE_LIMITS.has(reason)) return new DriveBusy(DRIVE_BUSY, 403)
    return new DriveUnauthorized(SIGN_IN_AGAIN, 403)
  }
  if (response.status === 429 || response.status >= 500) return new DriveBusy(DRIVE_BUSY, response.status)
  return new DriveError(`Drive answered ${response.status} for ${url}`, response.status)
}

async function driveFetch(
  fetchImpl: FetchLike,
  accessToken: string,
  url: string,
  init: RequestInit = {},
  retryDelayMs = RETRY_DELAY_MS,
): Promise<Response> {
  const send = (): Promise<Response> =>
    fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` } })

  const response = await send()
  if (response.ok) return response
  const failure = await refusal(response, url)
  // A busy Drive gets one more try after a pause, but only a request that is
  // safe to send twice: a create that reached Drive before it failed would
  // leave two files of the same name.
  if (!(failure instanceof DriveBusy) || init.method === 'POST') throw failure
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  const again = await send()
  if (again.ok) return again
  throw await refusal(again, url)
}

/** One request to Drive, as a backend makes it: see `driveFetch`. */
type DriveRequest = (accessToken: string, url: string, init?: RequestInit) => Promise<Response>

export interface DriveBackendOptions {
  /** Called before every request; returns a token that is valid *now*. */
  accessToken: () => Promise<string>
  fetchImpl?: FetchLike
  /**
   * The file this backend reads and writes: the library by default, or the
   * small positions file (`positions.ts`), which syncs on its own schedule.
   */
  name?: string
  /** The pause before a busy Drive's one more try; the tests set it to nothing. */
  retryDelayMs?: number
}

/** The document's file, as a listing or an upload describes it. */
interface DriveFile {
  id: string
  /** Drive's checksum of the content; absent if Drive did not report one. */
  md5Checksum?: string
}

/**
 * Find the document's file, or `null` if this account has never synced.
 *
 * Searched by name on every sync rather than remembered across them: the id is
 * per-account, and remembering one would have to be invalidated whenever the
 * user signs in as somebody else or clears the app folder from Drive's
 * settings. One listing per sync is a fair price for having no stale-id case.
 */
async function findFile(request: DriveRequest, accessToken: string, name: string): Promise<DriveFile | null> {
  // No `spaces` filter is needed and none would help: under `drive.file` a
  // listing only ever contains files this app created, so the name is already
  // searched within our own small world.
  const query = new URLSearchParams({
    q: `name = '${name}' and trashed = false`,
    fields: 'files(id,md5Checksum)',
    pageSize: '1',
  })
  const response = await request(accessToken, `${FILES_URL}?${query}`)
  const body = (await response.json()) as { files?: Partial<DriveFile>[] }
  const file = body.files?.[0]
  return file?.id ? { id: file.id, md5Checksum: file.md5Checksum } : null
}

/** Asked of every upload, so its answer says what the file now holds. */
const UPLOAD_FIELDS = 'fields=id,md5Checksum'

export function createDriveBackend<T = StoreDocument>(options: DriveBackendOptions): SyncBackend<T> {
  const { accessToken, fetchImpl = fetch, name = DOCUMENT_NAME, retryDelayMs = RETRY_DELAY_MS } = options
  const request: DriveRequest = (token, url, init) => driveFetch(fetchImpl, token, url, init, retryDelayMs)

  /**
   * The file as this backend last saw it: found by the pull, and then what the
   * push put there.
   *
   * Most syncs find the remote exactly as this device left it — nothing
   * happened elsewhere since — and the listing's checksum says so, so the
   * download of the whole library is skipped and this text is used instead. A
   * different or missing checksum always downloads; the cache can only ever
   * save a request, never supply a stale document. Kept as text rather than
   * the parsed document, because the parsed one goes on to become the live
   * library and would change under the cache.
   */
  let lastSeen: { id: string; md5Checksum: string; text: string } | null = null
  /** The id this sync's pull found; `undefined` before any pull, `null` for none. */
  let pulledId: string | null | undefined

  const remember = (file: DriveFile | null, text: string): void => {
    lastSeen = file?.md5Checksum ? { id: file.id, md5Checksum: file.md5Checksum, text } : null
  }

  /**
   * What an upload says the file now is, or `null` if it did not say.
   *
   * Only ever an optimisation: the upload has already succeeded by the time
   * this runs, and failing the sync over an unreadable answer would report a
   * saved library as unsaved.
   */
  const described = async (response: Response): Promise<DriveFile | null> => {
    const body = (await response.json().catch(() => null)) as Partial<DriveFile> | null
    return body?.id ? { id: body.id, md5Checksum: body.md5Checksum } : null
  }

  const upload = async (token: string, id: string | null, payload: string): Promise<DriveFile | null> => {
    if (id !== null) {
      const response = await request(token, `${UPLOAD_URL}/${id}?uploadType=media&${UPLOAD_FIELDS}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      return described(response)
    }

    /**
     * Creating the file takes a multipart body, because the first part is the
     * metadata that gives it its name. Without that it would be created as
     * "Untitled", which is both unfindable for the user and unmatched by the
     * lookup above — so every sync would make another one.
     */
    const boundary = `wta-${Math.random().toString(36).slice(2)}`
    const metadata = JSON.stringify({ name })
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n` +
      `--${boundary}--`

    const response = await request(token, `${UPLOAD_URL}?uploadType=multipart&${UPLOAD_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    return described(response)
  }

  return {
    async pull(): Promise<RemoteDocument<T> | null> {
      const token = await accessToken()
      const file = await findFile(request, token, name)
      pulledId = file?.id ?? null
      if (file === null) return null

      let text: string
      if (lastSeen && lastSeen.id === file.id && lastSeen.md5Checksum === file.md5Checksum) {
        text = lastSeen.text
      } else {
        const response = await request(token, `${FILES_URL}/${file.id}?alt=media`)
        text = await response.text()
        // The listing's checksum, which the file may have moved past between
        // the two requests. That only makes the next sync download again.
        remember(file, text)
      }

      let document: T
      try {
        document = JSON.parse(text) as T
      } catch {
        // Someone else's bytes, or a truncated upload. Treated as "no remote
        // document" rather than as a hard failure: the next push replaces it,
        // and refusing to sync forever over one bad file helps nobody.
        return null
      }

      // `modifiedTime` would be a natural version, but Drive offers no way to
      // make an update conditional on it — see the note on `RemoteDocument`.
      return { document, version: null }
    },

    async push(document: T, _expected: string | null): Promise<void> {
      const token = await accessToken()
      const payload = JSON.stringify(document)
      // The pull that always precedes a push found the file seconds ago, so it
      // is not listed a second time. Deleted since then, the update 404s and
      // the file is created afresh, as a listing would have concluded.
      const id = pulledId !== undefined ? pulledId : ((await findFile(request, token, name))?.id ?? null)

      let file: DriveFile | null
      try {
        file = await upload(token, id, payload)
      } catch (err) {
        if (!(err instanceof DriveError && err.status === 404) || id === null) throw err
        file = await upload(token, null, payload)
      }
      // Unknown if the upload did not describe itself; the next push lists.
      pulledId = file?.id
      remember(file, payload)
    },
  }
}

/**
 * The signed-in account's address, for the settings screen only.
 *
 * Best effort: `drive.file` alone does not grant the userinfo endpoint, so this
 * reads Drive's own `about` resource, and a failure here must never stop a
 * sync. A connected account with no label is a cosmetic problem; a sync that
 * refuses to run because it could not fetch a label is a real one.
 */
export async function fetchAccountEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const response = await driveFetch(
      fetchImpl,
      accessToken,
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
    )
    const body = (await response.json()) as { user?: { emailAddress?: string } }
    return body.user?.emailAddress ?? null
  } catch {
    return null
  }
}
