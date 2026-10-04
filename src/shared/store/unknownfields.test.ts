/**
 * A field a newer build added survives a trip through an older one.
 *
 * `migrate` rebuilt every document from the fields it knew, and the merge
 * started from the local copy, so a top-level field from a newer build was
 * dropped on load and on pull, and the next push wrote the file without it.
 * The phone and the desktop often run different builds.
 */

import { describe, expect, it } from 'vitest'

import { emptyDocument } from './core'
import type { StoreDocument } from './document'
import { mergeDocuments } from './merge'
import { migrate } from './migrate'
import { syncOnce } from '../sync/engine'
import { DOCUMENT_NAME } from '../sync/drive'
import { FakeDrive, libraryHost, storeOn } from '../sync/fakedrive.fixture'

/** A document as a newer build might write it, with a field this build does not know. */
function fromNewerBuild(value: unknown, schemaVersion = 3): StoreDocument {
  return { ...emptyDocument('newer'), schemaVersion, watchParties: value } as StoreDocument
}

const field = (doc: StoreDocument): unknown => (doc as unknown as Record<string, unknown>).watchParties

describe('fields this build does not know', () => {
  it('are kept by migrate', () => {
    expect(field(migrate(fromNewerBuild([{ id: 'p1' }])))).toEqual([{ id: 'p1' }])
  })

  it('are carried by the merge from whichever side has them', () => {
    expect(field(mergeDocuments(emptyDocument('here'), migrate(fromNewerBuild([{ id: 'p1' }]))))).toEqual([{ id: 'p1' }])
  })

  it('come from the side with the newer schema when both have them', () => {
    const here = fromNewerBuild(['old'], 3)
    const newer = fromNewerBuild(['new'], 4)
    expect(field(mergeDocuments(here, newer))).toEqual(['new'])
    expect(field(mergeDocuments(newer, here))).toEqual(['new'])
  })

  it('are still in the file after this build syncs a change', async () => {
    const drive = new FakeDrive()
    drive.seed(DOCUMENT_NAME, fromNewerBuild([{ id: 'p1' }]))
    const store = await storeOn('phone')
    store.collection('watched').put({
      id: 'w1',
      tmdbId: 550,
      type: 'movie',
      season: null,
      title: 'Fight Club',
      posterPath: null,
      imdbId: 'tt0137523',
      genreIds: [],
      rating: 0,
      addedAt: 1,
      source: 'user',
      malId: null,
    })

    await syncOnce(libraryHost(store), drive.backend())

    const file = JSON.parse(drive.file(DOCUMENT_NAME)) as StoreDocument
    expect(file.watched.map((w) => w.id)).toEqual(['w1'])
    expect(field(file)).toEqual([{ id: 'p1' }])
  })
})
