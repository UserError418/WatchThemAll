/**
 * The phone's persistence, and nothing else.
 *
 * The store itself — coalescing, migration, the collection API, the metadata
 * that keeps the document mergeable — is `@shared/store`, identical to the
 * desktop's. This file supplies the four methods that need a platform.
 *
 * ## Why Filesystem rather than Preferences
 *
 * Capacitor's Preferences API is Android `SharedPreferences`: an XML key-value
 * file the platform reads into memory and rewrites wholesale. It is meant for
 * settings — a handful of small values. This document is the user's entire
 * library: a watchlist, a watch history, hundreds of playback outcomes and
 * possibly a MAL import of several hundred titles. Storing that as one giant
 * SharedPreferences string works right up until it does not, and the failure
 * mode is a silent truncation on write.
 *
 * A real file in the app's private data directory is what the desktop uses and
 * what a document this size wants.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { StoreCore } from '@shared/store/core'
import type { StorePersistence } from '@shared/store/core'
import { migrate } from '@shared/store/migrate'

/** App-private storage: not world-readable, and removed when the app is. */
const DIRECTORY = Directory.Data

/**
 * Whether a Filesystem error means the file is not there.
 *
 * The Android plugin marks it with its own code (`FilesystemErrors.kt`,
 * `doesNotExist`); the message check covers the web implementation, which
 * the Chromium preview runs.
 */
function isMissingFile(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown }
  return code === 'OS-PLUG-FILE-0008' || (typeof message === 'string' && /does not exist/i.test(message))
}

/** A JSON file written atomically: the library's, and the test history's (`resultstore.ts`). */
export class CapacitorPersistence implements StorePersistence {
  /** Where each write lands before it replaces the file; see `write`. */
  private readonly tempFile: string
  /** Where an unparseable document is kept, so a fresh start is not a data loss. */
  private readonly corruptFile: string

  /** `file` is a name ending in `.json`, such as `watchthemall.json`. */
  constructor(private readonly file: string) {
    this.tempFile = `${file}.tmp`
    this.corruptFile = file.replace(/\.json$/, '.corrupt.json')
  }

  async read(): Promise<string | null> {
    try {
      const file = await Filesystem.readFile({
        path: this.file,
        directory: DIRECTORY,
        encoding: Encoding.UTF8,
      })
      return file.data as string
    } catch (err) {
      // Only *missing* may read as null: the store answers null with a fresh
      // library and writes it out, so an unreadable file taken for a missing
      // one was overwritten. Anything else is rethrown, and the store then
      // leaves the file alone for the session. (A file that reads but will
      // not parse is a different path, the one that reaches `quarantine`.)
      if (isMissingFile(err)) return null
      throw err
    }
  }

  /**
   * Write beside the library, then rename over it, as the desktop does.
   *
   * Written in place, a process killed mid-write (Android does that to
   * background apps) left a truncated library, which the next launch
   * quarantined and replaced with an empty one. A rename either happens or
   * does not, so the worst a kill can do now is leave a half-written temporary
   * file that nothing reads. Checked on the emulator on 2026-09-27: the
   * plugin's `rename` replaces an existing destination.
   */
  async write(text: string): Promise<void> {
    await Filesystem.writeFile({
      path: this.tempFile,
      directory: DIRECTORY,
      encoding: Encoding.UTF8,
      data: text,
    })
    await Filesystem.rename({ from: this.tempFile, to: this.file, directory: DIRECTORY, toDirectory: DIRECTORY })
  }

  async quarantine(): Promise<void> {
    // One slot, unlike the desktop's timestamped copies: phone storage is not
    // something the user can browse to clean up, and the *first* failure holds
    // the most data — so a repeat launch must not overwrite it. `copy` fails
    // silently here if the destination exists, which is the behaviour wanted.
    await Filesystem.copy({
      from: this.file,
      directory: DIRECTORY,
      to: this.corruptFile,
      toDirectory: DIRECTORY,
    })
  }
}

export class MobileStore extends StoreCore {
  constructor() {
    super(new CapacitorPersistence('watchthemall.json'), migrate, 'phone')
  }
}
