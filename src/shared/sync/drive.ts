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

async function driveFetch(
  fetchImpl: FetchLike,
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  })

  if (response.status === 401 || response.status === 403) {
    throw new DriveUnauthorized(
      'Drive refused the credential; sign in again to resume syncing.',
      response.status,
    )
  }
  if (!response.ok) {
    throw new DriveError(`Drive answered ${response.status} for ${url}`, response.status)
  }
  return response
}

export interface DriveBackendOptions {
  /** Called before every request; returns a token that is valid *now*. */
  accessToken: () => Promise<string>
  fetchImpl?: FetchLike
}

/**
 * Find the document's file id, or `null` if this account has never synced.
 *
 * Searching by name rather than remembering an id: the id is per-account, and
 * remembering one would have to be invalidated whenever the user signs in as
 * somebody else or clears the app folder from Drive's settings. One extra
 * request per sync is a fair price for having no stale-id case at all.
 */
async function findFileId(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<string | null> {
  // No `spaces` filter is needed and none would help: under `drive.file` a
  // listing only ever contains files this app created, so the name is already
  // searched within our own small world.
  const query = new URLSearchParams({
    q: `name = '${DOCUMENT_NAME}' and trashed = false`,
    fields: 'files(id,modifiedTime)',
    pageSize: '1',
  })
  const response = await driveFetch(fetchImpl, accessToken, `${FILES_URL}?${query}`)
  const body = (await response.json()) as { files?: { id?: string }[] }
  return body.files?.[0]?.id ?? null
}

export function createDriveBackend(options: DriveBackendOptions): SyncBackend {
  const { accessToken, fetchImpl = fetch } = options

  return {
    async pull(): Promise<RemoteDocument | null> {
      const token = await accessToken()
      const id = await findFileId(fetchImpl, token)
      if (id === null) return null

      const response = await driveFetch(fetchImpl, token, `${FILES_URL}/${id}?alt=media`)
      const text = await response.text()

      let document: StoreDocument
      try {
        document = JSON.parse(text) as StoreDocument
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

    async push(document: StoreDocument, _expected: string | null): Promise<void> {
      const token = await accessToken()
      const id = await findFileId(fetchImpl, token)
      const payload = JSON.stringify(document)

      if (id !== null) {
        await driveFetch(fetchImpl, token, `${UPLOAD_URL}/${id}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        })
        return
      }

      /**
       * Creating the file takes a multipart body, because the first part is the
       * metadata that gives it its name. Without that it would be created as
       * "Untitled", which is both unfindable for the user and unmatched by the
       * lookup above — so every sync would make another one.
       */
      const boundary = `wta-${Math.random().toString(36).slice(2)}`
      const metadata = JSON.stringify({ name: DOCUMENT_NAME })
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n` +
        `--${boundary}--`

      await driveFetch(fetchImpl, token, `${UPLOAD_URL}?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
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
