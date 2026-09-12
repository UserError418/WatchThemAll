/**
 * Where the desktop keeps the refresh token.
 *
 * A refresh token is a long-lived key to one folder of the user's Drive, so it
 * gets the operating system's credential store rather than a JSON file beside
 * the library — Keychain on macOS, libsecret on Linux, DPAPI on Windows, all
 * behind Electron's `safeStorage`.
 *
 * ## When encryption is unavailable
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no keyring
 * running, which is a perfectly ordinary desktop and not an error. The choice
 * there is between refusing to remember the sign-in and writing the token in
 * the clear, and this refuses: a plaintext refresh token in a predictable path
 * is worth more to anyone who finds it than the convenience is worth to the
 * user, and the failure is visible — Settings says why, and sync still works
 * for the session.
 *
 * The file is written `0600` regardless. That is not a substitute for
 * encryption; it is the floor.
 */

import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { StoredCredentials } from '@shared/sync/types'

const FILE_NAME = 'sync-credentials.bin'

export class TokenStore {
  constructor(private readonly path = join(app.getPath('userData'), 'data', FILE_NAME)) {}

  /** Whether this machine can keep a sign-in between runs at all. */
  get canPersist(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async read(): Promise<StoredCredentials | null> {
    if (!this.canPersist) return null

    let encrypted: Buffer
    try {
      encrypted = await readFile(this.path)
    } catch {
      return null // Never signed in, or the user cleared it.
    }

    try {
      return JSON.parse(safeStorage.decryptString(encrypted)) as StoredCredentials
    } catch {
      /**
       * Undecryptable rather than absent.
       *
       * This is what a restored backup looks like on a machine whose keyring
       * differs, and there is nothing to recover — the bytes are lost, not
       * corrupted. Deleting them turns a permanent error into one sign-in.
       */
      await this.clear()
      return null
    }
  }

  async write(credentials: StoredCredentials): Promise<void> {
    if (!this.canPersist) return

    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, safeStorage.encryptString(JSON.stringify(credentials)))
    // After the write, not before: `writeFile` creates with the process umask,
    // so a mode passed to it can be widened by an inherited umask of 0.
    await chmod(this.path, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}
