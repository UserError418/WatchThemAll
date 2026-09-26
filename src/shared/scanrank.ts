/**
 * How good a provider looks for one title, and how that is drawn.
 *
 * In `shared/` rather than in `main/` because both processes need the *same*
 * answer, and this is the pair that must never disagree:
 *
 *   - main orders the fallback chain with `providerRank`
 *   - the renderer colours each dot with `providerDot`
 *
 * The source pickers list their rows in Automatic's own order — main sends it
 * with each title's provider state, see `TitleProviderState.order` — so green
 * rows sit above amber ones and red ones sink to the bottom, favourites and
 * then the user's order deciding within each. The Providers panel is the
 * exception and stays in the user's drag order: it is a drag-to-reorder
 * surface, and resorting it under the user would be worse than useless.
 *
 * So the colour has to mean exactly what the ranking does: a green row that
 * Automatic skips, or a red one it picks, is the app contradicting itself in
 * the one place the user looks to predict it.
 *
 * Two copies of the rule would hold until someone adjusted one of them, and the
 * failure would be silent. So the ordering lives here once, and the colour is
 * derived from the ordering rather than decided beside it.
 */

import type { ProbeVerdict, ResumeSource, TitleOutcome } from './ipc'
import type { ScanReason, SourceSortKey } from './types'
import { describeReason } from './scanreason'

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
  reason?: ScanReason,
): ProviderDot {
  const rank = providerRank(outcome, verdict)
  /*
   * A test that knows why a source failed says so, in the same colour the rank
   * gives it. Only for the two tiers a test decides: the history tiers (1, 4)
   * describe plays, which carry no reason.
   */
  if (reason && (rank === 2 || rank === 5)) {
    return { tone: rank === 2 ? 'warn' : 'bad', ...describeReason(reason) }
  }
  switch (rank) {
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

/**
 * The words beside the resume source, in both pickers.
 *
 * When it was moved up, the label says from where: the list is Automatic's
 * order, so a source jumping to the top after one evening's viewing would
 * otherwise look like the ordering had changed its mind about it. "was 3rd"
 * says the ordering stands and this title is the exception.
 */
export function resumeNote(resume: ResumeSource): { label: string; hint: string } {
  if (resume.movedFrom === null) {
    return { label: 'resume', hint: 'Automatic starts here: this title was last streamed on it' }
  }
  const was = ordinal(resume.movedFrom + 1)
  return {
    label: `resume · was ${was}`,
    hint: `Automatic starts here, because this title was last streamed on it. Otherwise it would be ${was} in line`,
  }
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const teens = n % 100 >= 11 && n % 100 <= 13
  const suffix = teens ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/**
 * `items` in the order `order` names them.
 *
 * For the source pickers, which hold providers in one order and are told
 * Automatic's in another. Anything `order` does not mention keeps its relative
 * place after everything it does: a provider enabled a moment ago, before the
 * next state arrives, should still be listed rather than vanish.
 */
export function inScanOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const place = new Map(order.map((id, index) => [id, index]))
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (place.get(a.item.id) ?? order.length) - (place.get(b.item.id) ?? order.length) ||
        a.index - b.index,
    )
    .map((entry) => entry.item)
}

/**
 * How long a source took to start streaming, for a label beside its name.
 *
 * Tenths under ten seconds, where the difference between 1.2 and 3.8 is the
 * point; whole seconds above, where a tenth is noise. Never "0.0 s" — a
 * measured stream took some time, and a zero reads like a missing value.
 */
export function formatStreamTime(ms: number): string {
  // Rounded before the threshold test, or 9.96 s would print as "10.0 s".
  const tenths = Math.round(Math.max(ms, 100) / 100) / 10
  return tenths < 10 ? `${tenths.toFixed(1)} s` : `${Math.round(tenths)} s`
}

/**
 * A quality class as a label: "1080p".
 *
 * Players' own menus say "1080p", so a user can hold this against the menu of
 * the source they picked and see that it agrees.
 */
export function formatQuality(quality: number): string {
  return `${quality}p`
}

/** Every key a source order can hold, in the default priority. See `Settings.sourceOrder`. */
export const SOURCE_SORT_KEYS: readonly SourceSortKey[] = ['list', 'speed', 'quality']

/**
 * A stored source order, made safe to sort by: known keys only, each once,
 * and any missing ones appended in default order.
 *
 * It decides what Automatic plays, so it cannot be allowed to be partial. A
 * document edited by hand, or written by a newer version that knows a key this
 * one does not, must still produce a complete order rather than a crash or a
 * provider that is never tried.
 */
export function normalizeSourceOrder(value: unknown): SourceSortKey[] {
  const known = new Set<string>(SOURCE_SORT_KEYS)
  const chosen = Array.isArray(value)
    ? value.filter((key): key is SourceSortKey => typeof key === 'string' && known.has(key))
    : []
  return [...new Set([...chosen, ...SOURCE_SORT_KEYS])]
}
