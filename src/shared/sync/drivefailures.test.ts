/**
 * What Drive refuses, and what the user is told about it.
 *
 * Every 401 and 403 used to read "sign in again". Drive answers 403 for a
 * full Drive and for its rate limits too, and signing in again helps with
 * neither: with a full Drive the user went round in circles while the library
 * stopped syncing. A rate limit, a 429 or a server error is worth one more
 * try after a pause, and otherwise a quiet note and a later sync, not a red
 * error.
 */

import { describe, expect, it } from 'vitest'

import { DriveBusy, DriveFull, DriveUnauthorized, DOCUMENT_NAME } from './drive'
import { afterFailure } from './failure'
import { FakeDrive } from './fakedrive.fixture'
import { emptyDocument } from '../store/core'

const listings = (drive: FakeDrive): string[] => drive.requests.filter((r) => r.startsWith('GET') && r.includes('/files?'))

describe('what Drive refuses', () => {
  it('says the Drive is full, rather than asking to sign in again, when there is no room', async () => {
    const drive = new FakeDrive()
    drive.failNext(403, 'storageQuotaExceeded')

    const error = await drive.backend().push(emptyDocument('desktop-1'), null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveFull)
    expect((error as Error).message).toMatch(/full/)
    expect(drive.requests).toHaveLength(1)
  })

  it('tries once more after a rate limit, and the sync goes through', async () => {
    const drive = new FakeDrive()
    drive.seed(DOCUMENT_NAME, emptyDocument('phone-1'))
    drive.failNext(403, 'userRateLimitExceeded')

    expect(await drive.backend().pull()).not.toBeNull()
    expect(listings(drive)).toHaveLength(2)
  })

  it('gives up after that one more try, as busy rather than refused', async () => {
    const drive = new FakeDrive()
    drive.failNext(429)
    drive.failNext(429)

    const error = await drive.backend().pull().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveBusy)
    expect(drive.requests).toHaveLength(2)
  })

  it('tries an upload once more after a server error', async () => {
    const drive = new FakeDrive()
    drive.seed(DOCUMENT_NAME, emptyDocument('phone-1'))
    const backend = drive.backend()
    await backend.pull()
    drive.failNext(503)

    await backend.push(emptyDocument('desktop-1'), null)

    expect(drive.requests.filter((r) => r.startsWith('PATCH'))).toHaveLength(2)
    expect(JSON.parse(drive.file(DOCUMENT_NAME)).deviceId).toBe('desktop-1')
  })

  it('never sends a create twice: a server error there waits for the next sync', async () => {
    const drive = new FakeDrive()
    const backend = drive.backend()
    await backend.pull()
    drive.failNext(500)

    const error = await backend.push(emptyDocument('desktop-1'), null).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveBusy)
    expect(drive.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1)
    expect(drive.count(DOCUMENT_NAME)).toBe(0)
  })

  it('still asks to sign in again when the credential itself is refused', async () => {
    const drive = new FakeDrive()
    drive.failNext(401)
    expect(await drive.backend().pull().catch((e: unknown) => e)).toBeInstanceOf(DriveUnauthorized)
    drive.failNext(403, 'insufficientPermissions')
    expect(await drive.backend().pull().catch((e: unknown) => e)).toBeInstanceOf(DriveUnauthorized)
  })
})

describe('what a failed sync shows', () => {
  it('shows a busy Drive as a quiet note, and tries again by itself', () => {
    const { status, retry } = afterFailure(new DriveBusy('Google Drive is busy right now.', 429))
    expect(status).toEqual({ state: 'idle', error: null, notice: 'Google Drive is busy right now.' })
    expect(retry).toBe(true)
  })

  it('shows anything else as an error', () => {
    const { status, retry } = afterFailure(new DriveFull('Your Google Drive is full.', 403))
    expect(status).toEqual({ state: 'error', error: 'Your Google Drive is full.', notice: null })
    expect(retry).toBe(false)
  })
})
