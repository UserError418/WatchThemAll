/**
 * What an imported export switches on reaches the other devices.
 *
 * The import added the export's providers to the active list without
 * stamping it, so the next sync took the list for an old value: another
 * device that had touched its list since kept its own and took the imported
 * providers away again here, and one that had not never picked them up.
 */

import { describe, expect, it } from 'vitest'

import { mergeDocuments } from '@shared/store/merge'
import { emptyStore } from './migrate'
import { importIntoStore } from './sync'

describe('importing an export', () => {
  it('stamps the providers it switches on, so the next sync carries them', () => {
    const here = emptyStore('here')
    here.activeProviderIds = ['moviesapi']
    here.preferenceUpdatedAt = { activeProviderIds: 1_000 }
    const elsewhere = emptyStore('elsewhere')
    elsewhere.activeProviderIds = ['moviesapi']
    elsewhere.preferenceUpdatedAt = { activeProviderIds: 2_000 }

    importIntoStore(here, { data: { vidsrc_active_providers: ['vidsrc'] } })

    expect(here.activeProviderIds).toEqual(['moviesapi', 'vidsrc'])
    expect(mergeDocuments(elsewhere, here).activeProviderIds).toEqual(['moviesapi', 'vidsrc'])
  })

  it('leaves the stamp alone when the export switches nothing new on', () => {
    const here = emptyStore('here')
    here.activeProviderIds = ['moviesapi']
    here.preferenceUpdatedAt = { activeProviderIds: 1_000 }

    importIntoStore(here, { data: { vidsrc_active_providers: ['moviesapi'] } })

    expect(here.preferenceUpdatedAt.activeProviderIds).toBe(1_000)
  })
})
