/**
 * Reading a provider's playback position out of what it volunteers.
 *
 * ## Why this exists
 *
 * The desktop learns where a video is by reading `currentTime` off the
 * provider's own `<video>` — a privilege of the Electron embedder, which can
 * run script in any frame whatever its origin. Nothing on Android can do that,
 * which makes reading the position look impossible there.
 *
 * It is not. Several providers *post their position out* to whatever is framing
 * them. Measured on an Android 16 emulator, listening on the app's own window
 * while an episode played:
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
 * Videasy posts its store as a **JSON string inside the envelope**, keyed by
 * media rather than by id, and with no timestamps at all — measured on the
 * emulator, 2026-09-20, against the frame the app had just opened:
 *
 * ```
 * {"type":"MEDIA_DATA","data":"{\"movie-550\":{\"poster\":\"…\",
 *   \"background\":\"…\",\"id\":550,\"mediaType\":\"movie\",
 *   \"title\":\"Fight Club\",
 *   \"progress\":{\"duration\":8348,\"watched\":6793.757424}}}"}
 * ```
 *
 * Two things in that shape defeated the first version of this parser, and
 * between them they are why the phone never learned a position from Videasy —
 * which is most plays, since it is the default source:
 *
 * 1. **`data` is a string.** The object test ran against it, found a string,
 *    and returned null. Every single one of these was discarded.
 * 2. **There is no `last_updated`.** Selecting "the entry being written right
 *    now" by newest timestamp cannot work on a store that carries none, so
 *    with more than one title in it the choice was arbitrary — and the
 *    caller's `tmdbId` check then correctly threw away the arbitrary answer.
 *
 * The fix for the second is to stop guessing: the caller knows what it asked
 * to play, so it says so, and the entry for *that* title is the one read. The
 * timestamp heuristic stays as the fallback for a store that has timestamps
 * and no context to match against.
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
 * Unwrap a payload that arrived as JSON text rather than as a structured clone.
 *
 * Applied at two levels, because providers double-encode at two levels: some
 * post the whole message as a string, and Videasy posts a structured envelope
 * whose `data` is a string. Anything that is not text is passed through
 * untouched.
 *
 * The `{` test comes first so this is not `JSON.parse` on every stray string a
 * page posts at its parent, which on an ad-funded page is a great many.
 */
function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('{')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
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
 * What the app asked the provider to play.
 *
 * Supplied so a whole-store payload can be read rather than guessed at: the
 * caller is the only thing that knows which of the twenty titles in a
 * provider's library is the one on screen. Optional, because a `PLAYER_EVENT`
 * needs none of it and the tests for that path should not have to invent one.
 */
export interface PlayerContext {
  tmdbId: number
  season: number | null
  episode: number | null
}

/**
 * Parse one `message` payload, or return null if it is not one of ours.
 *
 * Null is the common case and not an error: an app window receives messages
 * from embeds, from analytics scripts, and from anything else that guesses at
 * `window.parent`. The caller is expected to ignore nulls silently.
 *
 * `want` narrows a whole-store payload to the title being played. Without it
 * the store is read by the timestamp heuristic, which is right for a provider
 * that stamps its entries and arbitrary for one that does not.
 */
export function parsePlayerMessage(
  raw: unknown,
  want: PlayerContext | null = null,
): PlayerReading | null {
  const envelope = asRecord(asJson(raw))
  if (envelope === null) return null
  if (envelope.type === 'MEDIA_DATA') return parseMediaData(envelope.data, want)
  if (envelope.type !== 'PLAYER_EVENT') return null

  const data = asRecord(asJson(envelope.data))
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
 * Read a provider's whole progress store.
 *
 * The payload is a library, not a report: every title that provider has played
 * in this WebView. Two providers send one, and they agree on nothing —
 * VidFast keys by id (`t95350`) and stamps each entry with `last_updated`;
 * Videasy keys by media (`movie-550`) and stamps nothing.
 *
 * So which entry is the one on screen?
 *
 * 1. **The one the caller asked for**, when it said. Exact on episode where
 *    the store names an episode, else the title. This is the only answer that
 *    is *known* rather than inferred, and it is why `want` exists.
 * 2. **The freshest `last_updated`**, when there is no context. Right for a
 *    provider that stamps, and the documented hazard applies: on a fresh load
 *    nothing has been written yet, so the newest stamp belongs to the previous
 *    session. The caller compares `tmdbId` against what it asked for and drops
 *    anything else; do not remove that check.
 * 3. **The first entry**, when neither applies. A store with one entry in it
 *    is the common case for this branch.
 *
 * A whole-store payload is also why the position is read from `show_progress`
 * where one exists rather than from the entry's top-level `progress`: the top
 * level is the show's *latest* position across all episodes, so on a series
 * where episode four was watched last, a reading for episode one would carry
 * episode four's position.
 */
function parseMediaData(raw: unknown, want: PlayerContext | null): PlayerReading | null {
  const library = asRecord(asJson(raw))
  if (library === null) return null

  const entries: Array<{ key: string; entry: Record<string, unknown>; at: number }> = []
  for (const [key, value] of Object.entries(library)) {
    const entry = asRecord(value)
    if (entry === null) continue
    entries.push({
      key,
      entry,
      at: typeof entry.last_updated === 'number' ? entry.last_updated : 0,
    })
  }
  if (entries.length === 0) return null

  const readings = entries
    .map((candidate) => ({ ...candidate, reading: readEntry(candidate.key, candidate.entry) }))
    .filter((candidate): candidate is typeof candidate & { reading: PlayerReading } =>
      candidate.reading !== null,
    )
  if (readings.length === 0) return null

  if (want !== null) {
    const mine = readings.filter((candidate) => candidate.reading.tmdbId === want.tmdbId)
    // An episode match beats a title match: a store keyed per episode holds
    // several rows for one series, and only one of them is being written.
    const exact = mine.find(
      (candidate) =>
        candidate.reading.season === want.season && candidate.reading.episode === want.episode,
    )
    if (exact) return exact.reading
    // Failing that, the entry that names no episode at all — a film, or a
    // store that keys by show — rather than a sibling episode's position.
    const unscoped = mine.find(
      (candidate) => candidate.reading.season === null && candidate.reading.episode === null,
    )
    if (unscoped) return unscoped.reading
    if (mine.length === 1) return mine[0]!.reading
  }

  let best = readings[0]!
  for (const candidate of readings) if (candidate.at > best.at) best = candidate
  return best.reading
}

/**
 * How Videasy names a row: `movie-550`, and `tv-<id>` with the season and
 * episode appended when it has them.
 *
 * Measured for the film form. The series form is read if it is there and
 * nothing depends on it being there — an entry that does not match falls back
 * to its own fields, which is how VidFast's `t95350` keys are handled.
 */
const MEDIA_KEY = /^(?:movie|tv)-(\d+)(?:-(\d+)-(\d+))?$/

/** One row of a store, as a reading, or null when it holds no position. */
function readEntry(key: string, entry: Record<string, unknown>): PlayerReading | null {
  const fromKey = MEDIA_KEY.exec(key)

  const id = tmdbId(entry.id) ?? (fromKey ? tmdbId(fromKey[1]) : null)
  const season =
    ordinal(entry.last_season_watched) ??
    ordinal(entry.season) ??
    (fromKey ? ordinal(fromKey[2]) : null)
  const episode =
    ordinal(entry.last_episode_watched) ??
    ordinal(entry.episode) ??
    (fromKey ? ordinal(fromKey[3]) : null)

  // A film has no `show_progress`; the entry's own `progress` is the whole
  // story. A series that keeps one has both, and only the per-episode one is
  // trustworthy — so a store with `show_progress` and no way to index it is
  // read as holding nothing rather than as holding the wrong episode.
  const shows = asRecord(entry.show_progress)
  const progress =
    shows === null
      ? asRecord(entry.progress)
      : season !== null && episode !== null
        ? asRecord(asRecord(shows[`s${season}e${episode}`])?.progress)
        : null
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
