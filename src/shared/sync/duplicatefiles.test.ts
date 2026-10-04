/**
 * Two files of the same name: every device settles on the same one.
 *
 * Two first syncs at once, or a listing that does not yet show a file created
 * seconds before, can leave two library files. The listing asked for one file
 * in no particular order, and Drive promises none, so each device could keep
 * syncing with a different copy while both said "synced".
 */

import { describe, expect, it } from 'vitest'

import { DOCUMENT_NAME } from './drive'
import { FakeDrive } from './fakedrive.fixture'
import { emptyDocument } from '../store/core'

describe('two files of the same name', () => {
  it('reads and writes the oldest, whichever device asks', async () => {
    const drive = new FakeDrive()
    drive.seed(DOCUMENT_NAME, emptyDocument('first'))
    drive.seed(DOCUMENT_NAME, emptyDocument('second'))

    expect((await drive.backend().pull())?.document.deviceId).toBe('first')
    await drive.backend().push(emptyDocument('desktop'), null)
    expect(JSON.parse(drive.file(DOCUMENT_NAME)).deviceId).toBe('desktop')
  })
})
