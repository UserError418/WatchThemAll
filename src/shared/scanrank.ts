/**
 * How good a provider looks for one title, and how that is drawn.
 *
 * In `shared/` rather than in `main/` because both processes need the *same*
 * answer, and this is the pair that must never disagree:
 *
 *   - main orders the fallback chain with `providerRank`
 *   - the renderer colours each dot with `providerDot`
 *
 * Note what the agreement is and is not. The source pickers list providers in
 * the user's own drag order, not in rank order — the Providers panel is a
 * drag-to-reorder surface and resorting it under the user would be worse than
 * useless. What the dots do is tell them which of those rows Automatic will
 * actually reach for first. So the colour has to mean exactly what the ranking
 * does: a green row that Automatic skips, or a red one it picks, is the app
 * contradicting itself in the one place the user looks to predict it.
 *
 * Two copies of the rule would hold until someone adjusted one of them, and the
 * failure would be silent. So the ordering lives here once, and the colour is
 * derived from the ordering rather than decided beside it.
 */

import type { ProbeVerdict, TitleOutcome } from './ipc'

/**
 * Where one provider sits in the fallback order, lowest first.
 *
 * The ranking, in words the user could be told:
 *
 *   0. measured working just now
 *   1. has played this title before
 *   2. alive, but nothing streamed — worth a try
 *   3. nothing known either way
 *   4. tried before, never produced a stream
 *   5. measured dead just now
 *
 * A fresh measurement outranks history in both directions, because it is the
 * more recent fact about a service that changes daily. The one place that is
 * not obvious is tier 1 beating tier 2: a provider that played this show last
 * week and merely failed to stream within the probe's budget is a better bet
 * than one that has never played it at all.
 */
export function providerRank(
  outcome: TitleOutcome | undefined,
  verdict: ProbeVerdict | undefined,
): number {
  if (verdict === 'stream') return 0
  if (verdict === 'dead') return 5
  if (outcome === 'worked') return 1
  if (verdict === 'unsure') return 2
  if (outcome === 'failed') return 4
  return 3
}

/**
 * What to paint in a provider row's dot slot.
 *
 * A *tone* rather than a colour, because the two surfaces that draw this list
 * cannot share one. `SourcePicker` lives in the app's document and reads
 * `var(--success)` from the token sheet; `PlayerChrome` is a separate document
 * with no stylesheet of its own and has always carried literal hex values. A
 * colour returned from here would be right in one of them and invisible in the
 * other.
 */
export interface ProviderDot {
  /** `null` is the empty slot: no claim at all. */
  tone: 'good' | 'warn' | 'bad' | null
  /** The `title` attribute — the claim, spelled out. */
  hint: string
  /** A short label beside the name, or null. Only for states worth calling out. */
  label: string | null
}

/**
 * The empty slot, which is a deliberate fourth state and not a grey dot.
 *
 * A dot of any colour is a claim, and "no idea" is not one. The space stays
 * reserved so the provider names do not jump around as scans fill in.
 */
const UNKNOWN: ProviderDot = {
  tone: null,
  hint: 'Not tried or scanned for this title yet',
  label: null,
}

/**
 * How one provider's row should look.
 *
 * Keyed off `providerRank` rather than off the raw verdicts, so a change to the
 * ordering moves the colours with it automatically. The `resume` case is
 * handled by the caller: it outranks everything here because it is the more
 * specific claim — every resume source is also a working one — and it is about
 * the *user's* history rather than about how good the source is.
 */
export function providerDot(
  outcome: TitleOutcome | undefined,
  verdict: ProbeVerdict | undefined,
): ProviderDot {
  switch (providerRank(outcome, verdict)) {
    case 0:
      return {
        tone: 'good',
        hint: 'Just tested — this source is streaming this title now',
        label: 'works',
      }
    case 1:
      return { tone: 'good', hint: 'Has played this title for you', label: null }
    case 2:
      return {
        tone: 'warn',
        /*
         * Not "broken", and not "untested" either.
         *
         * This verdict exists so that a bot challenge or a slow CDN does not
         * condemn a working provider, so the wording has to leave the user
         * willing to click it. It said "untested", which was worse than vague:
         * the user had just pressed "Test all sources", so it read as a claim
         * that the test had skipped the source — and it collided with the
         * genuine never-tested state, which is the blank dot below. One word
         * for two opposite meanings.
         *
         * What actually happened is that the source answered and no stream
         * followed, which for the user means: try it if the green ones fail.
         */
        hint: 'Tested — the source answered but no stream appeared. It may still work',
        label: 'may work',
      }
    case 4:
      return { tone: 'bad', hint: 'Tried, and could not play this title', label: 'no stream' }
    case 5:
      return {
        tone: 'bad',
        hint: 'Just tested — no stream for this title',
        label: 'no stream',
      }
    default:
      return UNKNOWN
  }
}
