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

import type { Episode, EpisodeStub, ReleaseTracker, StoreShape, Synced } from '@shared/types'
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
    putMany(trackers: Array<Omit<Synced<ReleaseTracker>, 'updatedAt' | 'deletedAt'>>): void
  }
}
import * as tmdb from './tmdb'

/** Spacing between TMDB calls, so a large tracker list does not burst. */
const REQUEST_SPACING_MS = 250

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How far either side of now `tracker.schedule` reaches.
 *
 * Back far enough to outlast the widest window the Releases tab offers (30
 * days) with room for a sweep that has not run in a while; forward far enough
 * that a season announced months ahead still appears on the timeline. Stored
 * rather than filtered at render time because the view cannot fetch.
 */
const SCHEDULE_BACK_DAYS = 45
const SCHEDULE_AHEAD_DAYS = 90

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
 * The episodes of a season worth storing, trimmed to stubs.
 *
 * Only the four fields the timeline draws. The full `Episode` carries an
 * overview and a still path, and keeping those would put a paragraph of prose
 * per episode into a document that syncs over Drive on every change.
 */
export function scheduleWindow(episodes: readonly Episode[], now = Date.now()): EpisodeStub[] {
  const from = now - SCHEDULE_BACK_DAYS * DAY_MS
  const to = now + SCHEDULE_AHEAD_DAYS * DAY_MS

  return episodes
    .filter((episode) => {
      if (!episode.airDate) return false
      const at = new Date(`${episode.airDate}T00:00:00`).getTime()
      return !Number.isNaN(at) && at >= from && at <= to
    })
    .map(({ season, episode, name, airDate }) => ({ season, episode, name, airDate }))
}

/**
 * Whether this sweep should spend a request on the season listing.
 *
 * A season's air dates do not change once published, so re-fetching every
 * hour would double the sweep's cost to re-learn the same answer. It is worth
 * paying when there is nothing stored, when the series has moved on to a
 * season the stored list does not cover, or when everything stored has already
 * aired — that last one being how a schedule that has simply run out is told
 * apart from one that is still current.
 */
export function needsSchedule(
  tracker: Pick<ReleaseTracker, 'schedule'>,
  season: number,
  now = Date.now(),
): boolean {
  const stored = tracker.schedule
  if (!stored || stored.length === 0) return true
  if (!stored.some((episode) => episode.season === season)) return true

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return !stored.some((episode) => {
    if (!episode.airDate) return false
    const at = new Date(`${episode.airDate}T00:00:00`).getTime()
    return !Number.isNaN(at) && at >= today.getTime()
  })
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

  /*
   * The timeline's raw material. Deliberately after `nextEpisode` is stored
   * and before any of the early returns below: an ended series still has a
   * last season worth drawing, and a first sighting still wants its dates.
   *
   * A failure here is swallowed and leaves `schedule` untouched rather than
   * clearing it — a stale timeline beats an empty one, and the notification
   * path below must not be lost to a season listing being unavailable.
   */
  const current = detail.nextEpisode?.season ?? detail.lastEpisode?.season ?? null
  if (current !== null && needsSchedule(tracker, current)) {
    try {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS))
      const season = await tmdb.season(tracker.tmdbId, current)
      tracker.schedule = scheduleWindow(season.episodes)
    } catch (err) {
      console.error(`[releases] season ${current} unavailable for "${tracker.title}":`, err)
    }
  }

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

/**
 * What a check writes on a tracker. Everything else on the record belongs to
 * the user or to sync, and is taken from the stored tracker at write time.
 */
const CHECKED_FIELDS = [
  'tmdbId',
  'title',
  'posterPath',
  'status',
  'nextEpisode',
  'lastNotified',
  'schedule',
  'lastChecked',
] as const satisfies ReadonlyArray<keyof ReleaseTracker>

/** The sweep in progress, so a second one joins it rather than running alongside. */
let running: Promise<ReleaseNotice[]> | null = null

/**
 * Check every tracker in sequence. Returns whatever the user should hear about.
 *
 * One sweep at a time. The hourly timer and "Check now" could overlap, and
 * both would announce the same new episode. A sweep asked for while one runs
 * waits for it and returns nothing, because the running one announces.
 */
export async function checkAll(store: SweepableStore): Promise<ReleaseNotice[]> {
  if (running) {
    await running.catch(() => {})
    return []
  }
  running = sweep(store)
  try {
    return await running
  } finally {
    running = null
  }
}

async function sweep(store: SweepableStore): Promise<ReleaseNotice[]> {
  const liveTrackers = (): Map<string, ReleaseTracker> =>
    new Map(store.read().trackers.map((tracker) => [tracker.id, tracker]))
  const results: Array<{ id: string; update: Partial<ReleaseTracker>; notice: ReleaseNotice | null }> = []

  for (const { id } of store.read().trackers) {
    const before = liveTrackers().get(id)
    if (!before) continue

    // Checked on a copy, and only the checked fields are kept. The sweep used
    // to change the records it read at the start and `put` them back, and
    // `put` revives a deleted record. So a series untracked while TMDB
    // answered (or removed by a sync that landed mid-sweep) came back, synced
    // out as tracked again, and could raise a notification for a series the
    // user had just dropped.
    const checked: ReleaseTracker = { ...before }
    let notice: ReleaseNotice | null = null
    try {
      notice = await checkTracker(checked)
    } catch (err) {
      // One unreachable series must not stop the rest of the sweep.
      console.error(`[releases] check failed for "${checked.title}":`, err)
      checked.lastChecked = Date.now()
    }

    const update: Partial<ReleaseTracker> = {}
    for (const field of CHECKED_FIELDS) Object.assign(update, { [field]: checked[field] })
    results.push({ id, update, notice })
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS))
  }

  // Written once, at the end, onto each tracker as it stands now. Every
  // tracker's `lastChecked` moves, so writing per tracker saved the whole
  // library a dozen times per sweep and reloaded the renderer's copy each
  // time. A tracker gone by now stays gone and announces nothing. Stopping
  // mid-sweep loses only the `lastChecked` stamps, and the next sweep simply
  // checks those series again.
  const live = liveTrackers()
  const kept = results.filter((result) => live.has(result.id))
  if (kept.length > 0) {
    store.collection('trackers').putMany(kept.map(({ id, update }) => ({ ...live.get(id)!, ...update })))
  }
  return kept.flatMap(({ notice }) => (notice ? [notice] : []))
}

/** Human-readable summary for a notification body. */
export function describeNotice(notice: ReleaseNotice): string {
  const { episode, kind } = notice
  const code = `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`
  const name = episode.name ? ` — ${episode.name}` : ''
  return kind === 'new_season' ? `Season ${episode.season} has begun${name}` : `${code}${name}`
}

/**
 * How long until a sweep is due: the interval after the *oldest* check.
 *
 * Read from the trackers rather than from when this process last swept, so a
 * restart does not buy a fresh sweep of every series — the data is exactly as
 * fresh as if the app had stayed open. The oldest rather than the newest
 * check, so a series that missed the last sweep (added since, or synced in
 * with `lastChecked: 0`) is not left waiting a full interval. `lastChecked`
 * syncs, so a sweep on the other device counts too; that sweep also moved
 * `lastNotified`, so this one would have had nothing left to announce.
 *
 * Never more than one interval, whatever a skewed clock elsewhere stamped.
 */
export function sweepDueIn(
  trackers: ReadonlyArray<Pick<ReleaseTracker, 'lastChecked'>>,
  intervalMs: number,
  now = Date.now(),
): number {
  if (trackers.length === 0) return intervalMs
  const oldest = Math.min(...trackers.map((tracker) => tracker.lastChecked))
  return Math.min(intervalMs, Math.max(0, oldest + intervalMs - now))
}

/** Room after launch for the window and the first views to load before the sweep's requests. */
const STARTUP_DELAY_MS = 15_000

/** The shortest gap between two timed sweeps, and the floor under the setting. */
const MIN_GAP_MS = 15 * 60 * 1000

/**
 * Sweep whenever one is due by `sweepDueIn`, never sooner than shortly after
 * startup.
 *
 * Returns a stop function. The original left its interval running across
 * window close and quit, which is why it needed a guard against firing while
 * the window was open.
 */
export function startReleaseTimer(
  store: SweepableStore,
  onNotices: (notices: ReleaseNotice[]) => void,
): () => void {
  // Read on every tick, so a changed setting applies without a restart.
  const intervalMs = (): number => Math.max(MIN_GAP_MS, (store.read().settings.releaseCheckMinutes || 60) * 60 * 1000)
  const dueIn = (): number => sweepDueIn(store.read().trackers, intervalMs())

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const schedule = (floorMs: number): void => {
    if (stopped) return
    timer = setTimeout(tick, Math.max(floorMs, dueIn()))
  }

  const tick = (): void => {
    // "Check now", or the other device, may have swept since this was set.
    if (dueIn() > 0) {
      schedule(0)
      return
    }
    void checkAll(store)
      .then((notices) => {
        if (notices.length > 0) onNotices(notices)
      })
      .catch((err) => console.error('[releases] sweep failed:', err))
      .finally(() => schedule(MIN_GAP_MS))
  }

  schedule(STARTUP_DELAY_MS)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
