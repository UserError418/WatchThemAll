/**
 * The arithmetic behind the cast remote.
 *
 * Pure, and separate from the component, because two of the three things in
 * here are the kind of off-by-one that renders as a working button doing the
 * wrong thing rather than as an error — stepping to episode 0, or a volume
 * slider that reports 101%.
 *
 * ## What "next episode" means while casting
 *
 * The same thing it means in the player's keyboard shortcuts
 * (`preload/player.ts`), deliberately: episode + 1, rolling into the next
 * season at the end of this one, and back to episode 1 of the previous season
 * going the other way. A second rule for the same gesture is a rule the user
 * has to learn twice.
 *
 * The rollover forward is only offered when the episode list has actually been
 * loaded. Without it there is no way to know the season has ended, and the
 * honest answer to "is there a next episode" is to keep counting — a provider
 * asked for an episode that does not exist fails visibly and recoverably,
 * where refusing to advance on a season whose list simply has not arrived
 * would strand the user on the last episode they could see.
 */

export interface EpisodeStep {
  season: number
  episode: number
}

/**
 * Where the next-episode button goes.
 *
 * `knownEpisodes` is how many episodes this season is known to have, or 0 when
 * the list has not loaded. Null is returned only for something with no episode
 * at all — a film — which is also why the button is absent there rather than
 * disabled: there is nothing to explain.
 */
export function nextEpisode(at: EpisodeStep | null, knownEpisodes = 0): EpisodeStep | null {
  if (at === null) return null
  if (knownEpisodes > 0 && at.episode >= knownEpisodes) {
    return { season: at.season + 1, episode: 1 }
  }
  return { season: at.season, episode: at.episode + 1 }
}

/**
 * Where the previous-episode button goes, or null at the very beginning.
 *
 * Stepping back across a season boundary lands on **episode 1** of the earlier
 * season rather than on its last. That is `preload/player.ts`'s existing
 * behaviour and it is a consequence of not knowing how long the previous
 * season is without fetching it — landing on episode 1 is wrong by a known
 * amount, where landing on a guessed episode number is wrong by an unknown one.
 */
export function previousEpisode(at: EpisodeStep | null): EpisodeStep | null {
  if (at === null) return null
  if (at.episode > 1) return { season: at.season, episode: at.episode - 1 }
  if (at.season > 1) return { season: at.season - 1, episode: 1 }
  return null
}

/**
 * How far through, 0–1, for the time bar.
 *
 * Zero rather than a fraction when the duration is unknown: a receiver reports
 * `duration: 0` until it has parsed the stream, and dividing by it produces
 * either Infinity or NaN, both of which render as a bar that has silently
 * vanished.
 */
export function progressFraction(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0, Math.min(1, seconds / duration))
}

/** A volume level as a whole percentage, clamped to the range a slider has. */
export function volumePercent(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.round(Math.max(0, Math.min(1, level)) * 100)
}

/**
 * What the remote is doing, which is not always "playing".
 *
 * `switching` and `beaming` exist because moving the television to another
 * episode is not instant and not reliable: the embed has to load it, the
 * provider has to fetch a stream, and only then can it be sent. Showing the
 * ordinary remote throughout would be showing transport controls for a
 * position that is about to be discarded.
 *
 * `stuck` is the documented ordinary case rather than an error — several
 * providers fetch nothing at all until their own play button is pressed, so
 * the remote says exactly that and keeps waiting.
 */
export type RemotePhase = 'playing' | 'switching' | 'beaming' | 'stuck'

/** How long to wait for a provider to hand over a stream before saying so. */
export const STREAM_WAIT_MS = 20_000

/** The step sizes on the two nudge buttons, in seconds. */
export const NUDGE_SECONDS = 30

/**
 * Where a seek should land, given a bar dragged to `fraction`.
 *
 * Rounded to whole seconds because a receiver's `SEEK` takes them and a
 * fractional one is a decimal place nobody sees; clamped inside the duration
 * so dragging to the very end does not ask for a position past it, which some
 * receivers answer by stopping.
 */
export function seekTarget(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return Math.round(Math.max(0, Math.min(duration - 1, clamped * duration)))
}

/** Where a nudge lands: `by` seconds from here, inside the stream. */
export function nudgeTarget(seconds: number, by: number, duration: number): number {
  const from = Number.isFinite(seconds) ? seconds : 0
  const target = from + by
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, Math.round(target))
  return Math.round(Math.max(0, Math.min(duration - 1, target)))
}
