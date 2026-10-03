/**
 * Each settings field is merged on its own stamp.
 *
 * Settings were one preference with one stamp, on the reasoning that they are
 * changed from one screen. They are not: the subtitle language is set from
 * the player and preview sound from the detail view. Picking subtitles on the
 * phone then carried the phone's whole settings object over a setting just
 * changed on the desktop, and auto-next came back on everywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyDocument } from './core'
import { mergeDocuments } from './merge'
import { syncOnce } from '../sync/engine'
import { FakeDrive, libraryHost, storeOn } from '../sync/fakedrive.fixture'

const T = Date.UTC(2026, 8, 1)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('settings across devices', () => {
  it('keeps a setting changed on one device when another field changes on the other', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)

    vi.setSystemTime(T + 60_000)
    desktop.patchSettings({ autoNext: false })
    vi.setSystemTime(T + 120_000) // the phone has not synced since; the bridge's `setSubtitleLanguage`
    phone.applyPatch({ settings: { ...phone.read().settings, subtitleLanguage: 'de' } })
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)
    await syncOnce(libraryHost(desktop), desktopBackend)

    for (const store of [desktop, phone]) {
      expect(store.read().settings.autoNext).toBe(false)
      expect(store.read().settings.subtitleLanguage).toBe('de')
    }
  })

  it('stamps only the fields that changed', async () => {
    const store = await storeOn('desktop')
    store.patchSettings({ skipIntro: false })
    vi.setSystemTime(T + 60_000)
    store.patchSettings({ autoNext: false })

    const stamps = store.raw().preferenceUpdatedAt
    expect(stamps['settings.skipIntro']).toBe(T)
    expect(stamps['settings.autoNext']).toBe(T + 60_000)
    expect(stamps['settings.previewAudio']).toBeUndefined()
    expect(stamps.settings).toBe(T + 60_000)
  })

  it('hands an older build’s one stamp to the fields that did not change', async () => {
    const store = await storeOn('desktop')
    store.raw().preferenceUpdatedAt = { settings: T }
    vi.setSystemTime(T + 60_000)
    store.patchSettings({ autoNext: false })

    const stamps = store.raw().preferenceUpdatedAt
    expect(stamps['settings.autoNext']).toBe(T + 60_000)
    expect(stamps['settings.previewAudio']).toBe(T)
  })

  it('reads a document from an older build, with one stamp for the object, field by field', () => {
    const here = emptyDocument('here')
    here.settings = { ...here.settings, autoNext: false, subtitleLanguage: 'de' }
    here.preferenceUpdatedAt = { settings: T + 300, 'settings.autoNext': T + 100, 'settings.subtitleLanguage': T + 300 }
    const older = emptyDocument('older')
    older.settings = { ...older.settings, autoNext: true, subtitleLanguage: 'fr' }
    older.preferenceUpdatedAt = { settings: T + 200 }

    const merged = mergeDocuments(here, older)

    expect(merged.settings.autoNext).toBe(true) // the older build changed something after T + 100
    expect(merged.settings.subtitleLanguage).toBe('de')
    // What an older build compares: the latest change to any field.
    expect(merged.preferenceUpdatedAt.settings).toBe(T + 300)
  })
})
