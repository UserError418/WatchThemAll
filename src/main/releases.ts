/**
 * Release tracking — the feature the app exists for.
 *
 * Walks the user's tracked series on a timer, asks TMDB what the latest aired
 * and next scheduled episodes are, and raises an OS notification when
 * something has aired that the user has not been told about yet.
 *
 * Two rules govern the notification, both learned from the original's false
 * positives:
 *
 * The baseline is set silently. A series added to the tracker today must not
 * immediately announce the episode that aired last week — the user did not ask
 * to be told about the past. The first check records where things stand and
 * says nothing.
 *
 * Ended series are never checked for new content. The original compared season
 * numbers without consulting status, so a finished show could report a "new
 * season" whenever TMDB corrected its metadata.
 */

import type { EpisodeStub, ReleaseTracker, StoreShape, Synced } from '@shared/types'
/**
 * Only what a sweep actually needs.
 *
 * Structural rather than the desktop `Store` class, because the phone build
 * has its own store — a Capacitor Filesystem document — and this module is
 * otherwise entirely portable. Naming the class here was the single import
 * that would have forced a second copy of the release logic.
 */
export interface SweepableStore {
  read(): StoreShape
  collection(key: 'trackers'): {
    put(tracker: Omit<Synced<ReleaseTracker>, 'updatedAt' | 'deletedAt'>): void
  }
}
import * as tmdb from './tmdb'

/** Spacing between TMDB calls, so a large tracker list does not burst. */
const REQUEST_SPACING_MS = 250

export interface ReleaseNotice {
  tracker: ReleaseTracker
  episode: EpisodeStub
  kind: 'new_season' | 'new_episode'
}

function isNewerThan(candidate: EpisodeStub, baseline: EpisodeStub | null): boolean {
  if (!baseline) return false
  if (candidate.season !== baseline.season) return candidate.season > baseline.season
  return candidate.episode > baseline.episode
}

/**
 * Bring one tracker up to date. Returns a notice if the user should be told,
 * or null. Mutates the tracker in place — the caller persists.
 */
export async function checkTracker(tracker: ReleaseTracker): Promise<ReleaseNotice | null> {
  // Trackers imported from another device carry no TMDB id; resolve by title
  // once and keep the result.
  if (!tracker.tmdbId) {
    const found = await tmdb.search(tracker.title, 1)
    const match = found.items.find((i) => i.type === 'tv')
    if (!match) {
      tracker.lastChecked = Date.now()
      return null
    }
    tracker.tmdbId = match.tmdbId
    tracker.posterPath ??= match.posterPath
  }

  const detail = await tmdb.detail(tracker.tmdbId, 'tv')
  tracker.lastChecked = Date.now()
  tracker.status = detail.status
  tracker.nextEpisode = detail.nextEpisode
  tracker.posterPath ??= detail.posterPath
  if (detail.title) tracker.title = detail.title

  const latest = detail.lastEpisode
  if (!latest) return null

  // First sighting: record the baseline, announce nothing.
  if (!tracker.lastNotified) {
    tracker.lastNotified = latest
    return null
  }

  if (detail.status === 'Ended' || detail.status === 'Canceled') return null
  if (!isNewerThan(latest, tracker.lastNotified)) return null

  const kind = latest.season > tracker.lastNotified.season ? 'new_season' : 'new_episode'
  tracker.lastNotified = latest
  return { tracker, episode: latest, kind }
}

/** Check every tracker in sequence. Returns whatever the user should hear about. */
export async function checkAll(store: SweepableStore): Promise<ReleaseNotice[]> {
  const data: StoreShape = store.read()
  const notices: ReleaseNotice[] = []

  for (const tracker of data.trackers) {
    try {
      const notice = await checkTracker(tracker)
      if (notice) notices.push(notice)
    } catch (err) {
      // One unreachable series must not stop the rest of the sweep.
      console.error(`[releases] check failed for "${tracker.title}":`, err)
      tracker.lastChecked = Date.now()
    }
    // Written per tracker rather than as one array at the end: `checkTracker`
    // mutates in place, so the store would otherwise never learn that anything
    // changed and could not stamp it. A sweep of forty series is forty writes,
    // which the store's own coalescing turns back into one.
    store.collection('trackers').put(tracker)
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS))
  }

  return notices
}

/** Human-readable summary for a notification body. */
export function describeNotice(notice: ReleaseNotice): string {
  const { episode, kind } = notice
  const code = `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`
  const name = episode.name ? ` — ${episode.name}` : ''
  return kind === 'new_season' ? `Season ${episode.season} has begun${name}` : `${code}${name}`
}

/**
 * Run `checkAll` on an interval, and once shortly after startup.
 *
 * Returns a stop function. The original left its interval running across
 * window close and quit, which is why it needed a guard against firing while
 * the window was open.
 */
export function startReleaseTimer(
  store: SweepableStore,
  onNotices: (notices: ReleaseNotice[]) => void,
): () => void {
  const minutes = store.read().settings.releaseCheckMinutes || 60
  const intervalMs = Math.max(15, minutes) * 60 * 1000

  const run = (): void => {
    void checkAll(store)
      .then((notices) => {
        if (notices.length > 0) onNotices(notices)
      })
      .catch((err) => console.error('[releases] sweep failed:', err))
  }

  const startupDelay = setTimeout(run, 15_000)
  const interval = setInterval(run, intervalMs)

  return () => {
    clearTimeout(startupDelay)
    clearInterval(interval)
  }
}
