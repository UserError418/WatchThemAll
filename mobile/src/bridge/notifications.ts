/**
 * Telling the user an episode has landed, on a platform that cannot run in the
 * background.
 *
 * ## The constraint that shapes all of this
 *
 * The desktop app keeps a timer in its main process and sweeps TMDB every few
 * hours. Nothing equivalent exists here: a Capacitor app is a WebView, and when
 * Android stops the activity the JavaScript stops with it. Running a real
 * background sweep would mean a `WorkManager` worker in Kotlin, and a worker
 * cannot call into the WebView anyway — it would need the whole TMDB client
 * reimplemented natively.
 *
 * So the sweep does not move to the background. The *notification* does.
 *
 * TMDB already tells us the date the next episode airs, and Android's
 * `AlarmManager` will happily deliver a notification weeks from now with the
 * app closed — `@capacitor/local-notifications` even re-registers pending
 * alarms after a reboot, via its own `BOOT_COMPLETED` receiver. So every time
 * the app is open it schedules the notifications it already knows are coming,
 * and the user hears about an episode on the day it airs whether or not they
 * have opened the app since.
 *
 * What that trades away: an air date TMDB revises after the last sweep is
 * announced on the old date. A sweep on resume corrects it, and the schedule is
 * rebuilt from scratch each time, so the error self-heals the next time the app
 * is opened.
 *
 * ## Inexact on purpose
 *
 * Exact alarms need `SCHEDULE_EXACT_ALARM`, which on Android 14 is not granted
 * by default and sends the user to a system settings page to grant. An episode
 * notification that arrives within the hour is worth exactly as much as one
 * that arrives on the second, so `allowWhileIdle` and the exact flag are both
 * left off and Android is free to batch it.
 */

import { LocalNotifications } from '@capacitor/local-notifications'
import type { ReleaseTracker } from '@shared/types'

/** Everything from this app goes in one channel the user can silence alone. */
const CHANNEL_ID = 'releases'

/**
 * Local time an episode notification fires on its air date.
 *
 * TMDB gives a date and no time, so one has to be chosen. Morning, because the
 * question this answers is "what can I watch tonight" and an answer that
 * arrives at 00:01 is one the user reads at breakfast anyway — as a
 * notification they have already dismissed in their sleep.
 */
const ANNOUNCE_HOUR = 9

/**
 * A stable 31-bit id for one episode of one series.
 *
 * Android notification ids are Java ints, and the obvious arithmetic
 * (`tmdbId * 1000 + …`) overflows for TMDB's six- and seven-digit ids. A hash
 * is not injective, but a collision here costs one notification replacing
 * another rather than anything the user can lose.
 */
function notificationId(tmdbId: number, season: number, episode: number): number {
  const key = `${tmdbId}:${season}:${episode}`
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  // Positive: the plugin rejects negative ids.
  return Math.abs(hash) % 2_000_000_000
}

/** `YYYY-MM-DD` at `ANNOUNCE_HOUR` local time, or null if it is already past. */
function announceAt(airDate: string): Date | null {
  const [year, month, day] = airDate.split('-').map(Number)
  if (!year || !month || !day) return null
  const at = new Date(year, month - 1, day, ANNOUNCE_HOUR, 0, 0, 0)
  return at.getTime() > Date.now() ? at : null
}

/**
 * Ask for the notification permission, once there is a reason to.
 *
 * Android 13 made `POST_NOTIFICATIONS` a runtime permission, and a prompt on
 * first launch — before the user has tracked anything — is the one they deny
 * out of hand. This is called after a sweep instead, so the dialog arrives
 * attached to a series they chose to follow.
 *
 * Returns false rather than throwing on a platform without notifications (the
 * browser preview), so callers can stay linear.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await LocalNotifications.checkPermissions()
    if (current.display === 'granted') return true
    if (current.display === 'denied') return false
    const asked = await LocalNotifications.requestPermissions()
    return asked.display === 'granted'
  } catch {
    return false
  }
}

/** Create the channel. Idempotent; Android ignores a repeat with the same id. */
async function ensureChannel(): Promise<void> {
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'New episodes',
      description: 'When an episode of a series you track airs',
      importance: 4,
      visibility: 1,
    })
  } catch {
    // Channels are Android-only; the preview has none.
  }
}

/** One episode the user should hear about now, not on a future date. */
export interface ReleaseNotice {
  title: string
  season: number
  episode: number
  episodeName: string
  tmdbId: number
}

/** Announce episodes a sweep found already aired. */
export async function notifyFound(notices: ReleaseNotice[]): Promise<void> {
  if (notices.length === 0) return
  if (!(await ensureNotificationPermission())) return
  await ensureChannel()

  try {
    await LocalNotifications.schedule({
      notifications: notices.map((n) => ({
        id: notificationId(n.tmdbId, n.season, n.episode),
        channelId: CHANNEL_ID,
        title: n.title,
        body: `S${String(n.season).padStart(2, '0')}E${String(n.episode).padStart(2, '0')}${
          n.episodeName ? ` · ${n.episodeName}` : ''
        } is out`,
        // No `schedule`, so it fires immediately.
      })),
    })
  } catch {
    // A failed notification must never fail the sweep that produced it.
  }
}

/**
 * Rebuild the whole set of future episode alarms from the trackers.
 *
 * Rebuilt rather than diffed, and deliberately: the alternative is storing what
 * was scheduled and reconciling against it, which is a second source of truth
 * that goes stale the moment a schedule is dropped — by a reboot the receiver
 * missed, by the user clearing app data, by a TMDB date correction. Asking the
 * platform what is pending and making it match the trackers cannot drift.
 *
 * Only this app's own ids are cancelled, so a stray id from anywhere else is
 * left alone.
 */
export async function syncScheduledReleases(trackers: ReleaseTracker[]): Promise<number> {
  if (!(await ensureNotificationPermission())) return 0
  await ensureChannel()

  const wanted = trackers
    .filter((tracker) => tracker.nextEpisode?.airDate)
    .map((tracker) => {
      const next = tracker.nextEpisode!
      const at = announceAt(next.airDate!)
      if (!at) return null
      return {
        id: notificationId(tracker.tmdbId, next.season, next.episode),
        channelId: CHANNEL_ID,
        title: tracker.title,
        body: `S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')}${
          next.name ? ` · ${next.name}` : ''
        } airs today`,
        schedule: { at, allowWhileIdle: false },
      }
    })
    .filter((n): n is NonNullable<typeof n> => n !== null)

  try {
    const pending = await LocalNotifications.getPending()
    const keep = new Set(wanted.map((n) => n.id))
    const stale = pending.notifications.filter((n) => !keep.has(n.id))
    if (stale.length > 0) {
      await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) })
    }

    if (wanted.length > 0) {
      // Re-scheduling an id that is already pending replaces it, which is what
      // makes a corrected air date take effect without a cancel first.
      await LocalNotifications.schedule({ notifications: wanted })
    }
    return wanted.length
  } catch {
    return 0
  }
}
