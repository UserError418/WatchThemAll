/**
 * Reading a provider's playback position out of what it volunteers.
 *
 * ## Why this exists
 *
 * The desktop learns where a video is by reading `currentTime` off the
 * provider's own `<video>` — a privilege of the Electron embedder, which can
 * run script in any frame whatever its origin. Nothing on Android can do that,
 * and `mobile/README.md` said for three versions that resume-to-position was
 * therefore impossible there.
 *
 * That was true of the approach, not of the problem. Several providers *post
 * their position out* to whatever is framing them, and nobody had looked.
 * Measured on an Android 16 emulator, listening on the app's own window while
 * an episode played:
 *
 * ```
 * VidFast   {"type":"PLAYER_EVENT","data":{"event":"timeupdate","currentTime":2.06,
 *            "duration":3388.63,"tmdbId":95350,"mediaType":"tv","season":1,
 *            "episode":1,"playing":false,"muted":true,"volume":0.8}}
 * Videasy   {"type":"PLAYER_EVENT","data":{"event":"timeupdate","currentTime":29.67,
 *            "duration":3388,"id":"95350","mediaType":"tv","season":1,"episode":1}}
 * Videasy   {"type":"PLAYER_EVENT","data":{"event":"timeupdate","timestamp":29.67,
 *            "duration":3388.63,"progress":0.87,"type":"tv","id":"95350",...}}
 * ```
 *
 * Two providers, three payload shapes, one family — these embeds share a
 * lineage and the differences are naming rather than meaning. VidLux, VidFlix
 * and VidRock post nothing at all, which is the case this has to survive
 * quietly: a provider that says nothing is not a provider that failed.
 *
 * VidFast also posts its **whole progress store**, unprompted, on every load
 * and then every few seconds as it plays:
 *
 * ```
 * {"type":"MEDIA_DATA","data":{"t95350":{"id":95350,"type":"tv",
 *   "title":"Lanterns","progress":{"watched":5.12,"duration":3388.63},
 *   "last_updated":1789280633632,"last_season_watched":1,
 *   "last_episode_watched":1,
 *   "show_progress":{"s1e1":{"season":1,"episode":1,
 *     "progress":{"watched":5.12,"duration":3388.63},...}}}}}
 * ```
 *
 * That is the better signal of the two: it names the title, it arrives without
 * the video having to be playing, and it is the provider's own resume database
 * rather than a sample of it. It is also the more dangerous one, because it is
 * **every title that provider has played in this WebView**, not the one we
 * asked for. Which brings us to the reason `tmdbId` is on the reading at all.
 *
 * ## Why a reading names its own title
 *
 * Choosing an entry out of that library means guessing which one is on screen,
 * and the guess here — the freshest `last_updated` — is right once something
 * has played and wrong before that. The first store a provider posts arrives
 * within a second of the frame loading, before our title has advanced by a
 * frame, so its newest entry is **whatever was watched last time**. Measured:
 * a store holding Lanterns from an earlier session and MobLand from the
 * current one, and the newest stamp belonged to whichever had run most
 * recently rather than to whichever was in the frame.
 *
 * So a reading carries the title it is about, the caller compares it against
 * the title it asked for, and a mismatch is discarded. Without that check the
 * first message of every session would file the previous session's position
 * onto the current title, and credit the provider with streaming it.
 *
 * ## What this module is, and is not
 *
 * A pure parser over untrusted input, and nothing else. It does not decide
 * whether a position is worth storing — `resume.ts` already owns that, and a
 * second opinion would eventually disagree with the first about what "watched"
 * means. It does not know which frame sent the message; the caller checks that,
 * because the caller is the only thing that holds the frame.
 *
 * Every field is validated. This runs on messages from a page whose business
 * model is advertising, so a payload claiming `currentTime: 1e308` or
 * `duration: -1` is not a hypothetical.
 */

/** One reading of a provider's playback state, normalised. */
export interface PlayerReading {
  /**
   * The TMDB id the provider says this is about, or null when it does not say.
   *
   * The caller must check it against what it asked for — see the note above on
   * whole-library payloads. Null means the provider named no title, which only
   * the `timestamp`-shaped `PLAYER_EVENT` does.
   */
  tmdbId: number | null
  /** Where the video is, in seconds. */
  seconds: number
  /** How long it is, in seconds, or null when the provider did not say. */
  duration: number | null
  /**
   * Which episode this reading is about, when the provider names one.
   *
   * Carried because a provider with its own "next episode" button moves on
   * without telling the app, and a position filed under the episode the app
   * *thinks* is playing would then be written against the wrong one.
   */
  season: number | null
  episode: number | null
  /** The element reached its own end. */
  ended: boolean
  /** False while paused, when the provider says; null when it does not. */
  playing: boolean | null
}

/** A plain object, as far as anything from a foreign page can be trusted. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * A finite, non-negative number, or null.
 *
 * Providers send seconds as both numbers and numeric strings — the same field
 * arrives as `29.675498` from one and `"29.675498"` from another — so a string
 * that parses is accepted. `Number('')` is 0 and `Number(' ')` is 0, which is
 * why the emptiness check comes first rather than relying on `Number.isFinite`.
 */
function seconds(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    value = Number(value)
  }
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value) || value < 0) return null
  // Thirty days. Past this the value is a millisecond timestamp, a bug, or a
  // lie, and none of the three belongs in a resume point.
  if (value > 30 * 24 * 60 * 60) return null
  return value
}

/** A positive integer, for a season or episode number. */
function ordinal(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value)
  if (typeof value !== 'number') return null
  if (!Number.isInteger(value) || value < 0 || value > 10_000) return null
  return value
}

/** A TMDB id, which providers send as both a number and a numeric string. */
function tmdbId(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value)
  if (typeof value !== 'number') return null
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * The events worth acting on.
 *
 * `timeupdate` is the stream of them; the rest are the edges. `ended` is here
 * even though no provider has been observed sending it, because the shape is
 * an HTML media event name and that is the name HTML uses — a provider that
 * forwards its element's events verbatim gets it for free.
 */
const POSITION_EVENTS = new Set(['timeupdate', 'seeked', 'pause', 'play', 'playing', 'ended'])

/**
 * Parse one `message` payload, or return null if it is not one of ours.
 *
 * Null is the common case and not an error: an app window receives messages
 * from embeds, from analytics scripts, and from anything else that guesses at
 * `window.parent`. The caller is expected to ignore nulls silently.
 */
export function parsePlayerMessage(raw: unknown): PlayerReading | null {
  // Some providers post the JSON as a string rather than as a structured
  // clone. Parsing anything that merely *looks* like an object would mean
  // running JSON.parse on every stray string a page posts, so the cheap shape
  // test comes first.
  let value = raw
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{')) return null
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
  }

  const envelope = asRecord(value)
  if (envelope === null) return null
  if (envelope.type === 'MEDIA_DATA') return parseMediaData(envelope.data)
  if (envelope.type !== 'PLAYER_EVENT') return null

  const data = asRecord(envelope.data)
  if (data === null) return null

  const event = typeof data.event === 'string' ? data.event : null
  if (event === null || !POSITION_EVENTS.has(event)) return null

  // `currentTime` from VidFast and one of Videasy's two shapes; `timestamp`
  // from the other. Same quantity, and a provider that sends both sends them
  // equal.
  const at = seconds(data.currentTime) ?? seconds(data.timestamp)
  if (at === null) return null

  const duration = seconds(data.duration)

  return {
    // `tmdbId` from VidFast, `id` from Videasy. The same number either way.
    tmdbId: tmdbId(data.tmdbId) ?? tmdbId(data.id),
    seconds: at,
    // Zero is what a provider reports before it knows, and a zero duration
    // makes every threshold in `resume.ts` meaningless. Absent is the honest
    // reading of it.
    duration: duration !== null && duration > 0 ? duration : null,
    season: ordinal(data.season),
    episode: ordinal(data.episode),
    ended: event === 'ended',
    playing: typeof data.playing === 'boolean' ? data.playing : null,
  }
}

/**
 * Pick the one title out of a provider's whole progress store that it is
 * currently updating.
 *
 * The payload is a library, not a report: every show that provider has played
 * in this WebView, each with its own `last_updated`. The newest stamp is the
 * entry being written right now — except on a fresh load, where nothing has
 * been written yet and the newest stamp belongs to the previous session. That
 * is survivable only because the caller compares `tmdbId` against what it asked
 * for and drops anything else; do not remove that check.
 *
 * A whole-store payload is also why the position here is read from
 * `show_progress` rather than the entry's top-level `progress`: the top level
 * is the show's *latest* position across all episodes, so on a series where
 * episode four was watched last, a reading for episode one would carry episode
 * four's position.
 */
function parseMediaData(raw: unknown): PlayerReading | null {
  const library = asRecord(raw)
  if (library === null) return null

  let newest: Record<string, unknown> | null = null
  let newestAt = -1
  for (const value of Object.values(library)) {
    const entry = asRecord(value)
    if (entry === null) continue
    const at = typeof entry.last_updated === 'number' ? entry.last_updated : 0
    if (at > newestAt) {
      newest = entry
      newestAt = at
    }
  }
  if (newest === null) return null

  const id = tmdbId(newest.id)
  const season = ordinal(newest.last_season_watched)
  const episode = ordinal(newest.last_episode_watched)

  // A film has no `show_progress`; the entry's own `progress` is the whole
  // story. A series has both, and only the per-episode one is trustworthy.
  const shows = asRecord(newest.show_progress)
  const episodeEntry =
    shows !== null && season !== null && episode !== null
      ? asRecord(shows[`s${season}e${episode}`])
      : null
  const progress = asRecord(episodeEntry?.progress ?? (shows === null ? newest.progress : null))
  if (progress === null) return null

  const at = seconds(progress.watched)
  if (at === null) return null
  const duration = seconds(progress.duration)

  return {
    tmdbId: id,
    seconds: at,
    duration: duration !== null && duration > 0 ? duration : null,
    season,
    episode,
    // The store records a position, never an end. A finished episode is
    // recognised by `resume.ts` from how close the position is to the duration.
    ended: false,
    playing: null,
  }
}
