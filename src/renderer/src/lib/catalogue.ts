/**
 * Exporting and importing the catalogue file, and what happened, in words.
 *
 * Settings and the app menu both offer these. The menu's Import and Export
 * dropped main's answer, so a file that would not import said nothing at all
 * (and neither did one that did); Settings had its own copy of the wording.
 */
import { library } from './library.svelte'

export interface FileResult {
  ok?: boolean
  cancelled?: boolean
  error?: string
}

/** The sentence for a file operation's answer, or null when the user cancelled the dialog. */
export function fileNote(result: FileResult | undefined, done: string, failed: string): string | null {
  if (result?.cancelled) return null
  return result?.ok ? done : (result?.error ?? failed)
}

export async function exportCatalogueFile(): Promise<string | null> {
  try {
    return fileNote((await window.wta.data.export()) as FileResult, 'Catalogue exported.', 'Export failed.')
  } catch (err) {
    return err instanceof Error ? err.message : 'Export failed.'
  }
}

export async function importCatalogueFile(): Promise<string | null> {
  let result: FileResult
  try {
    result = (await window.wta.data.import(null)) as FileResult
  } catch (err) {
    return err instanceof Error ? err.message : 'Import failed.'
  }
  // Main merged into the stored document; the in-memory copy is now stale and
  // would keep showing the pre-import catalogue.
  if (result?.ok) await library.reload()
  return fileNote(result, 'Catalogue imported.', 'Import failed.')
}
