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

const FILE = 'watchthemall.json'
/** Where an unparseable document is kept, so a fresh start is not a data loss. */
const CORRUPT_FILE = 'watchthemall.corrupt.json'
/** App-private storage: not world-readable, and removed when the app is. */
const DIRECTORY = Directory.Data

class CapacitorPersistence implements StorePersistence {
  async read(): Promise<string | null> {
    try {
      const file = await Filesystem.readFile({
        path: FILE,
        directory: DIRECTORY,
        encoding: Encoding.UTF8,
      })
      return file.data as string
    } catch {
      // No file yet. An unreadable one throws from `JSON.parse` instead, which
      // is the path that reaches `quarantine`.
      return null
    }
  }

  async write(text: string): Promise<void> {
    await Filesystem.writeFile({
      path: FILE,
      directory: DIRECTORY,
      encoding: Encoding.UTF8,
      data: text,
    })
  }

  async quarantine(): Promise<void> {
    // One slot, unlike the desktop's timestamped copies: phone storage is not
    // something the user can browse to clean up, and the *first* failure holds
    // the most data — so a repeat launch must not overwrite it. `copy` fails
    // silently here if the destination exists, which is the behaviour wanted.
    await Filesystem.copy({
      from: FILE,
      directory: DIRECTORY,
      to: CORRUPT_FILE,
      toDirectory: DIRECTORY,
    })
  }

  async describe(): Promise<string> {
    try {
      const { uri } = await Filesystem.getUri({ path: FILE, directory: DIRECTORY })
      return decodeURIComponent(uri.replace(/^file:\/\//, ''))
    } catch {
      return 'app storage'
    }
  }
}

export class MobileStore extends StoreCore {
  constructor() {
    super(new CapacitorPersistence(), migrate, 'phone')
  }
}
