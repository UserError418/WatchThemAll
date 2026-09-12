/**
 * Is the provider serving the thing that was asked for?
 *
 * Every health check in this project so far answers "does something play".
 * None of them answers "does the *right* thing play", and the difference is not
 * academic: a provider was measured at 10/10 on the network probe and 100% on
 * the player probe while serving an entirely different series, watermarked by
 * another site. From the outside that is a perfect provider. From the user's
 * seat it is useless, and worse than a dead one — a dead provider falls back,
 * a lying one does not.
 *
 * The only fact available to compare against is how long the thing runs.
 * `PlayRequest.runtimeMinutes` already carries TMDB's figure, so the check is
 * one subtraction.
 *
 * ## What this can and cannot do
 *
 * It catches gross substitution: a three-minute error clip, a trailer, a
 * feature film where a 22-minute episode was asked for. It does **not** catch a
 * different episode of similar length, and it never will — duration is a weak
 * signal and pretending otherwise would be the same overclaiming this exists to
 * correct.
 *
 * ## Why the tolerance is generous
 *
 * The cost of the two mistakes is not symmetric. Missing a substitution leaves
 * the user where they already were. Wrongly condemning a good provider demotes
 * it, sends the user to a worse source, and does so invisibly — they cannot
 * tell it happened, so they cannot argue with it. TMDB's runtimes are also
 * approximate, cuts differ by region, and embeds routinely prepend a few
 * seconds. So the band is wide on purpose, and anything inside it is simply
 * "plausible" rather than "verified".
 */

/** Below this, a "duration" is a placeholder or an advert rather than content. */
const ABSURDLY_SHORT_SECONDS = 180

/** Never accuse over less than this, however small the title's runtime. */
const MINIMUM_TOLERANCE_MINUTES = 10

/** Proportional slack, for the long titles where minutes alone are too tight. */
const TOLERANCE_FRACTION = 0.25

export type RuntimeVerdict = 'plausible' | 'implausible' | 'unknown'

export interface RuntimeCheck {
  verdict: RuntimeVerdict
  /** Why, in words a log line can carry unedited. */
  reason: string
}

export interface RuntimeCheckInput {
  /** Duration the provider's `<video>` reports, in seconds. */
  deliveredSeconds: number
  /** What TMDB says this runs for, in minutes. Null when TMDB does not say. */
  expectedMinutes: number | null
}

const UNKNOWN = (reason: string): RuntimeCheck => ({ verdict: 'unknown', reason })

/**
 * Judge one delivered duration.
 *
 * Pure, so the thresholds can be argued with in a test rather than in
 * production. `unknown` is a first-class answer and the default: no evidence is
 * not evidence of wrongdoing, and a check that must produce a verdict will
 * eventually produce a wrong one.
 */
export function checkRuntime(input: RuntimeCheckInput): RuntimeCheck {
  const { deliveredSeconds, expectedMinutes } = input

  if (expectedMinutes === null || !Number.isFinite(expectedMinutes) || expectedMinutes <= 0) {
    return UNKNOWN('TMDB has no runtime for this title')
  }
  // A live stream reports Infinity, and a video that has not loaded its
  // metadata reports 0 or NaN. Neither is a claim about content.
  if (!Number.isFinite(deliveredSeconds) || deliveredSeconds <= 0) {
    return UNKNOWN('no duration reported yet')
  }

  const deliveredMinutes = deliveredSeconds / 60

  if (deliveredSeconds < ABSURDLY_SHORT_SECONDS && expectedMinutes >= 10) {
    return {
      verdict: 'implausible',
      reason: `${deliveredMinutes.toFixed(1)} min delivered for a ${expectedMinutes} min title`,
    }
  }

  const tolerance = Math.max(MINIMUM_TOLERANCE_MINUTES, expectedMinutes * TOLERANCE_FRACTION)
  const drift = Math.abs(deliveredMinutes - expectedMinutes)

  if (drift > tolerance) {
    return {
      verdict: 'implausible',
      reason:
        `${deliveredMinutes.toFixed(1)} min delivered, TMDB says ${expectedMinutes} min ` +
        `(off by ${drift.toFixed(1)}, tolerated ${tolerance.toFixed(1)})`,
    }
  }

  return {
    verdict: 'plausible',
    reason: `${deliveredMinutes.toFixed(1)} min against ${expectedMinutes} min expected`,
  }
}
