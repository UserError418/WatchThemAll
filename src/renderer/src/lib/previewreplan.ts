/**
 * Whether new test results for a title should make the detail view plan its
 * stream preview again.
 *
 * The hero plays the title itself when this device's tests found a source
 * that starts fast enough (`main/previewplan.ts`), and the plan was asked for
 * only when the view opened, or when the player closed. So a title opened
 * before its sources were tested kept the trailer (or the still) after "Test
 * all sources" had found a fast source, until it was opened again; results
 * from a background or automatic test, a play elsewhere or a sync were no
 * different.
 *
 * Planning again starts the preview over, so it happens only while nothing
 * streams in the hero: not over a preview that is playing, nor one loading
 * behind the still, nor the kept copy, whether it plays or holds its last
 * frame for the source to take over. Doing it there would interrupt the very
 * thing it exists to show, and the preview's own result, filed as its film
 * starts, would start it over every time. Nor while the last question is
 * still unanswered: its answer is on the way.
 *
 * The view then asks, and starts over only if the answer has a preview to
 * play. Started over for nothing, the trailer would go and come back each
 * time the background tester filed a result for the title.
 */

/** What the detail view's hero is doing, in the terms this decision needs. */
export interface HeroNow {
  /** The preview for the episode on show was asked for, and answered (`stream.plan`). */
  answered: boolean
  /** The source's preview is mounted: loading behind the still, or playing (`streamPlan`). */
  streamMounted: boolean
  /** The kept copy is loaded: playing, or holding its last frame (`copy`). */
  copyLoaded: boolean
  /** The player is open. Closing it asks for the preview again anyway. */
  playerOpen: boolean
  /** Resume is carrying the preview into the player, or handing over to it. */
  carrying: boolean
}

/** True when the hero shows only the trailer or the still, so a new plan interrupts nothing. */
export function mayPlanAgain(hero: HeroNow): boolean {
  return hero.answered && !hero.streamMounted && !hero.copyLoaded && !hero.playerOpen && !hero.carrying
}
