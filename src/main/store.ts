/**
 * The desktop's persistence, and nothing else.
 *
 * Everything that used to be here — coalescing writes, the migration, the
 * corrupt-document handling — moved to `@shared/store`, where the phone build
 * runs the same code. What is left is the part that genuinely needs Node.
 *
 * The write is **atomic**: serialise to `<file>.tmp`, then rename. A rename
 * within one filesystem is atomic, so a crash mid-write leaves the previous
 * good document rather than a truncated one. That property is why this is not
 * simply `writeFile`.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StoreCore } from '@shared/store/core'
import type { StorePersistence } from '@shared/store/core'
import { migrate } from '@shared/store/migrate'

/** A JSON file written atomically: the library's, and the test history's (`resultstore.ts`). */
export class NodePersistence implements StorePersistence {
  constructor(
    readonly dir: string,
    readonly file: string,
    /** Indented, for a file someone may open to read or repair by hand. */
    readonly pretty = true,
  ) {}

  read(): Promise<string | null> {
    if (!existsSync(this.file)) return Promise.resolve(null)
    return Promise.resolve(readFileSync(this.file, 'utf-8'))
  }

  write(text: string): Promise<void> {
    const tmp = `${this.file}.tmp`
    mkdirSync(this.dir, { recursive: true })
    // The library is pretty-printed: it is the user's whole library and the
    // one thing they might open in an editor to check or repair by hand.
    writeFileSync(tmp, this.pretty ? JSON.stringify(JSON.parse(text), null, 2) : text, 'utf-8')
    renameSync(tmp, this.file)
    return Promise.resolve()
  }

  quarantine(): Promise<string> {
    // Timestamped rather than one fixed slot: on a desktop the file is easy to
    // reach, disk is not scarce, and a second failure should not overwrite the
    // first copy — which is usually the one with the most data in it. A rename
    // that fails (a virus scanner holding the file) throws, and the store then
    // leaves the file alone for the session.
    const backup = `${this.file}.corrupt-${Date.now()}`
    renameSync(this.file, backup)
    console.error(`[store] unreadable document moved to ${backup}`)
    return Promise.resolve(backup)
  }
}

export class Store extends StoreCore {
  readonly dir: string
  readonly file: string

  constructor(dir = join(app.getPath('userData'), 'data')) {
    const file = join(dir, 'watchthemall.json')
    super(new NodePersistence(dir, file), migrate, 'desktop')
    this.dir = dir
    this.file = file
  }
}
