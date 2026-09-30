/**
 * Whether a title's detail view plays its stream instead of the trailer, and
 * from where.
 *
 * Agreed with the owner (2026-09-27, revised 2026-09-28): any film or series
 * whose sources this device has tested, when one of them started streaming
 * within `PREVIEW_MAX_START_MS`. It plays at the place Play or Resume would
 * start (the saved position, or the beginning).
 *
 * The preview and Resume use one source, so pressing Resume carries on with
 * what was just on screen (the owner's "warm start"). Sharing the preview's
 * session with the player as well was measured on 2026-09-28 and removed:
 * cold 4.7 s against warm 5.0 s to a moving film, because the time is the
 * source's own start-up, not its downloads. Which one: Resume's usual pick when that qualifies, so nothing
 * changes for a title whose usual source is fast enough; otherwise the
 * fastest source that qualifies, and Resume follows the preview. A source
 * picked by hand is never overruled: if it does not qualify, there is no
 * preview.
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

/** Raised from 4 s by the owner after trying it (2026-09-28). */
export const PREVIEW_MAX_START_MS = 8_000

export interface PreviewChoice {
  provider: Provider
  /** The provider's URL for this episode or film, with the start in it where the source takes one. */
  url: string
  /** Where the preview should be: the saved position, or 0. */
  startSeconds: number
  /** How long the test took to see this source's stream start; null for `keptPreview`. */
  streamMs: number | null
}

/**
 * The source to preview from, or null when nothing qualifies.
 *
 * `providers` are the enabled ones in Automatic's order (resume source
 * first), whose first playable entry is Resume's usual pick. `req.providerId`
 * is a source picked by hand, which is Resume's pick instead. `scan` is this
 * device's fresh row for the title (`freshScan`), so aged-out and overtaken
 * results are already gone.
 */
/**
 * A source's preview behind a kept copy (`planPreview`), when no test here
 * qualified. The copy is on screen at once and covers a start slower than
 * the tests' 8 s. Without this, a phone whose titles were tested on the PC
 * kept windows it never showed (2026-09-30).
 */
export function keptPreview(
  provider: Provider,
  req: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode'>,
  resume: ResumeOffer | null,
): PreviewChoice | null {
  const url = renderTemplate(provider, req, resume)
  return url === null ? null : { provider, url, startSeconds: resume?.seconds ?? 0, streamMs: null }
}

export function choosePreview(input: {
  providers: readonly Provider[]
  scan: ProviderScan | null
  req: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode' | 'providerId'>
  resume: ResumeOffer | null
}): PreviewChoice | null {
  const { providers, scan, req, resume } = input
  if (scan === null) return null

  const qualifying = (provider: Provider): PreviewChoice | null => {
    const ms = scan.timings?.[provider.id]
    if (scan.verdicts[provider.id] !== 'stream') return null
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms > PREVIEW_MAX_START_MS) return null
    const url = renderTemplate(provider, req, resume)
    return url === null ? null : { provider, url, startSeconds: resume?.seconds ?? 0, streamMs: ms }
  }

  const picked = req.providerId ? providers.find((p) => p.id === req.providerId) : undefined
  const usual = picked ?? providers.find((p) => renderTemplate(p, req, resume) !== null)
  const usualChoice = usual === undefined ? null : qualifying(usual)
  if (usualChoice !== null) return usualChoice
  // Picked by hand and not fast enough (or untested): the pick stands, unpreviewed.
  if (req.providerId) return null

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

/**
 * What the detail view previews: `choosePreview`'s answer, else — when a
 * window is kept for this episode (`keptSource`, from whatever source) — the
 * source Resume would use, else nothing.
 *
 * With a copy on screen at once, the source behind it may be slow or
 * untested here: the copy covers its start. That source is the one Resume
 * plays (picked by hand, else the first in Automatic's order), not
 * necessarily the one the copy came from; the owner, 2026-09-30: the copy
 * "always plays, even if there is a mismatch between current chosen provider
 * and where the cache came from". Two sources' cuts can differ by a few
 * seconds, which the handover then shows as a small jump.
 */
export function planPreview(input: Parameters<typeof choosePreview>[0] & { keptSource: string | null }): PreviewChoice | null {
  const tested = choosePreview(input)
  if (tested !== null || input.keptSource === null) return tested
  const { providers, req, resume } = input
  const picked = req.providerId ? providers.find((p) => p.id === req.providerId) : undefined
  for (const provider of picked ? [picked] : providers) {
    const choice = keptPreview(provider, req, resume)
    if (choice !== null) return choice
  }
  return null
}
