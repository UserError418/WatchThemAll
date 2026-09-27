/**
 * The facts store's requests: what it asks TMDB, and when it does not ask again.
 */

import { expect, it, vi } from 'vitest'

const detail = vi.fn(async () => null)
vi.stubGlobal('window', { wta: { tmdb: { detail } } })

const { titleFacts } = await import('./titlefacts.svelte')

/** Lets the queued request run and settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An import that never resolved kept asking every time its row came into view. */
it('does not ask again this session about a title TMDB does not know', async () => {
  titleFacts.want('tv', 1677043)
  await settled()
  titleFacts.want('tv', 1677043)
  await settled()

  expect(detail).toHaveBeenCalledTimes(1)
  expect(titleFacts.get('tv', 1677043)).toBeNull()
})
