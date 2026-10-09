/**
 * What a failed test means: its verdict, and the words beside the dot.
 *
 * One table, because the two used to be decided in different places and said
 * less than the test knew. A source whose backend answered 500 on every title,
 * one still loading when the test gave up, and one whose playlist loaded while
 * every video segment was refused all read "may work" or "no stream". The user
 * could not tell a broken source from a slow one, and so could not decide
 * whether it was worth waiting for.
 *
 * The colours follow what the user should do, agreed on 2026-09-26:
 *
 * - **red** for anything the test saw fail, including a timeout. A source that
 *   needs more than the test's budget to start is not one Automatic should try
 *   before a working one; the label still says "timeout", so it can be picked
 *   by someone willing to wait.
 * - **amber** for a bot check. The player carries cookies the throwaway
 *   test session does not, so a challenge often passes there.
 * - **amber** for a source that played something else (`wrong-video`, since
 *   2026-10): a clip, an advert or another programme where the title should
 *   be. Not green, because the stream is not the film. Not red, because a
 *   red is a source the user never picks and Automatic tries last, and the
 *   test sees only the first seconds of a page: an advert in front of the
 *   film reads the same as a clip in its place. Amber keeps it below every
 *   source that played the film and still in reach; a false red would
 *   remove a working source without anyone noticing.
 *
 * Every red is re-tested alone before it is believed (`scanservice.ts`), which
 * is what makes red safe to hand out for a single bad answer.
 */

import { somethingElse } from './rightfilm'
import type { ProbeVerdict, ScanReason } from './types'

/** The verdict a reason stands for. */
export function verdictForReason(reason: ScanReason): ProbeVerdict {
  return reason.kind === 'blocked' || reason.kind === 'wrong-video' ? 'unsure' : 'dead'
}

/** The short label beside a provider's name, and the hover text that spells it out. */
export interface ReasonText {
  label: string
  hint: string
}

export function describeReason(reason: ScanReason): ReasonText {
  switch (reason.kind) {
    case 'error':
      return {
        label: `error ${reason.status}`,
        hint: `Tested — the source's server answered ${reason.status} and no stream followed`,
      }
    case 'refused':
      return {
        label: `stream refused (${reason.status})`,
        hint: `Tested — the source found a stream, but its video was refused (${reason.status})`,
      }
    case 'timeout':
      return {
        label: `timeout (${reason.seconds} s)`,
        hint: `Tested — still loading after ${reason.seconds} seconds. It may play if you wait`,
      }
    case 'blocked':
      return {
        label: 'blocked',
        hint: 'Tested — a bot check stopped the test. It may still work when you play it',
      }
    case 'unreachable':
      return { label: 'unreachable', hint: 'Tested — the source could not be reached' }
    case 'unsupported':
      return { label: 'not supported', hint: "This source's links cannot express this title" }
    case 'no-stream':
      return { label: 'no stream', hint: 'Tested — the page loaded, but no stream appeared' }
    case 'wrong-video':
      return {
        label: 'something else',
        hint: `Tested — this source ${somethingElse(reason.seconds, reason.expectedMinutes, reason.title)}`,
      }
  }
}
