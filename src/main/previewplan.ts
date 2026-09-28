/**
 * Whether a title's detail view plays its stream instead of the trailer, and
 * from where.
 *
 * Agreed with the owner (2026-09-27): any film or series whose sources this
 * device has tested, when at least one of them started streaming within
 * `PREVIEW_MAX_START_MS`. The fastest of those plays, at the place Play or
 * Resume would start (the saved position, or the beginning). Which source
 * Resume itself uses is not touched: that stays with the usual order.
 *
 * Only this device's own results count. Shared results from another device
 * carry no timings (`scanshare.ts`), and a phone's start time says nothing
 * about the desktop's anyway.
 *
 * Shared by both apps: the desktop's main process and the phone's bridge
 * each call `choosePreview` with their own store and providers.
 */

import type { PlayRequest } from '@shared/ipc'
import type { Provider, ProviderScan } from '@shared/types'
import { renderTemplate } from './providers'
import type { ResumeOffer } from './resume'

/** "Faster than 3.5–4 s", settled at 4 s (the owner). */
export const PREVIEW_MAX_START_MS = 4_000

export interface PreviewChoice {
  provider: Provider
  /** The provider's URL for this episode or film, with the start in it where the source takes one. */
  url: string
  /** Where the preview should be: the saved position, or 0. */
  startSeconds: number
  /** How long the test took to see this source's stream start. */
  streamMs: number
}

/**
 * The source to preview from, or null when nothing qualifies.
 *
 * `providers` are the enabled ones in the user's order, which breaks ties
 * between equally fast sources. `scan` is this device's fresh row for the
 * title (`freshScan`), so aged-out and overtaken results are already gone.
 */
export function choosePreview(input: {
  providers: readonly Provider[]
  scan: ProviderScan | null
  req: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode'>
  resume: ResumeOffer | null
}): PreviewChoice | null {
  const { providers, scan, req, resume } = input
  if (scan === null) return null

  const fast = providers
    .map((provider, order) => ({ provider, order, ms: scan.timings?.[provider.id] }))
    .filter(
      (entry): entry is { provider: Provider; order: number; ms: number } =>
        scan.verdicts[entry.provider.id] === 'stream' &&
        typeof entry.ms === 'number' &&
        Number.isFinite(entry.ms) &&
        entry.ms <= PREVIEW_MAX_START_MS,
    )
    .sort((a, b) => a.ms - b.ms || a.order - b.order)

  for (const { provider, ms } of fast) {
    const url = renderTemplate(provider, req, resume)
    if (url !== null) return { provider, url, startSeconds: resume?.seconds ?? 0, streamMs: ms }
  }
  return null
}
