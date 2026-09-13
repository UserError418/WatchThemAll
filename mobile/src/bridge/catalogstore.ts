/**
 * The phone's home for the provider catalogue cache.
 *
 * The desktop keeps it in a JSON file beside the user's data; there is no such
 * file here, and nothing in `catalog.ts` cares — it asks a `CatalogStore` for a
 * string and hands one back, which is the whole point of that split.
 *
 * ## Why Preferences rather than the app's own store
 *
 * The catalogue is not the user's data. It is a cache of a public document, it
 * is replaced wholesale on every successful refresh, and losing it costs one
 * fetch. Putting it in `watchthemall.json` would mean it travelled through
 * migration, through the sync merge, and into every export — a hundred-odd
 * providers of public information copied between devices that can each fetch
 * them in a second.
 *
 * Preferences is `SharedPreferences` underneath, which is the right shape for
 * exactly this: a small blob the platform persists, keeps out of the document,
 * and drops when the user clears app data.
 */

import { Preferences } from '@capacitor/preferences'

import type { CatalogStore } from '@main/catalog'

const KEY = 'provider-catalog'

export function preferencesCatalogStore(): CatalogStore {
  return {
    async read() {
      const { value } = await Preferences.get({ key: KEY })
      return value
    },
    async write(blob) {
      await Preferences.set({ key: KEY, value: blob })
    },
  }
}
