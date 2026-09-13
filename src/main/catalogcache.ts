/**
 * The desktop's home for the provider catalogue cache.
 *
 * Split out of `catalog.ts` so that file can be imported by the Android build,
 * which has no `node:fs` and cannot tolerate one appearing anywhere in the
 * module graph. Everything interesting — the fetch, the ETag round trip, the
 * all-or-nothing validation, the three-layer resolution — stayed there and is
 * now shared. What is left here is the two lines that touch a disk.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

import type { CatalogStore } from './catalog'

/** Where the last good fetch is kept, so a cold start is not a blank list. */
export function cachePath(dataDir: string): string {
  return join(dataDir, 'provider-catalog.json')
}

/**
 * A `CatalogStore` over a JSON file beside the user's data.
 *
 * `read` reports a missing file as null rather than throwing: on first run
 * there is no cache, and that is the ordinary case, not an error.
 */
export function fileCatalogStore(dataDir: string): CatalogStore {
  return {
    async read() {
      try {
        return await readFile(cachePath(dataDir), 'utf8')
      } catch {
        return null
      }
    },
    async write(blob) {
      const path = cachePath(dataDir)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, blob)
    },
  }
}
