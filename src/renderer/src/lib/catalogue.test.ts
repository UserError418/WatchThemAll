/**
 * The catalogue file's import and export say what happened, wherever they
 * are started: Settings shows the sentence, the app menu toasts it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dataImport = vi.fn()
const dataExport = vi.fn()
vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) }, data: { import: dataImport, export: dataExport } } })

const { library } = await import('./library.svelte')
const { exportCatalogueFile, fileNote, importCatalogueFile } = await import('./catalogue')

beforeEach(() => {
  dataImport.mockReset()
  dataExport.mockReset()
})

describe('fileNote', () => {
  it('says nothing when the dialog was cancelled', () => {
    expect(fileNote({ cancelled: true }, 'Done.', 'Failed.')).toBeNull()
  })

  it("passes main's reason on", () => {
    expect(fileNote({ ok: false, error: 'Not a WatchThemAll export' }, 'Done.', 'Failed.')).toBe('Not a WatchThemAll export')
    expect(fileNote({ ok: false }, 'Done.', 'Failed.')).toBe('Failed.')
  })
})

describe('importCatalogueFile', () => {
  it('reloads the library and says so when the file imported', async () => {
    const reload = vi.spyOn(library, 'reload').mockResolvedValue()
    dataImport.mockResolvedValue({ ok: true })

    expect(await importCatalogueFile()).toBe('Catalogue imported.')
    expect(reload).toHaveBeenCalled()
  })

  it('says why when it did not, and reloads nothing', async () => {
    const reload = vi.spyOn(library, 'reload').mockClear().mockResolvedValue()
    dataImport.mockResolvedValue({ ok: false, error: 'Not a WatchThemAll export' })

    expect(await importCatalogueFile()).toBe('Not a WatchThemAll export')
    expect(reload).not.toHaveBeenCalled()
  })

  it('says what went wrong when main throws', async () => {
    dataImport.mockRejectedValue(new Error('EACCES: permission denied'))

    expect(await importCatalogueFile()).toBe('EACCES: permission denied')
  })
})

describe('exportCatalogueFile', () => {
  it('says the file was written', async () => {
    dataExport.mockResolvedValue({ ok: true })

    expect(await exportCatalogueFile()).toBe('Catalogue exported.')
  })
})
