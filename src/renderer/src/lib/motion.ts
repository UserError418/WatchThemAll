/**
 * The app's motion vocabulary, as Svelte transition presets.
 *
 * Two reasons this is a module rather than a `transition:fly` written out at
 * each call site. The obvious one is consistency — six surfaces open and close
 * in this app, and before this they did it in six different ways, which is to
 * say instantly. The less obvious one is `prefers-reduced-motion`: CSS
 * transitions honour it because every duration in `tokens.css` collapses to
 * zero, but a Svelte transition takes its duration as a *number in JavaScript*
 * and will happily animate for 340 ms regardless. That check has to live
 * somewhere, and somewhere is here.
 *
 * The easing functions are the JS counterparts of the CSS curves in
 * `tokens.css`, not new ones — `expoOut` is what `--ease-out` traces, `backOut`
 * is `--ease-pop`. Keeping them paired matters because a surface routinely
 * animates in with a transition and settles with a CSS transition, and two
 * curves that nearly match read as a stutter.
 */

import { backOut, cubicIn, expoOut } from 'svelte/easing'
import type { FlyParams, ScaleParams, TransitionConfig } from 'svelte/transition'
import { fly, scale, fade } from 'svelte/transition'

/**
 * Whether the user has asked for less motion.
 *
 * Read at call time rather than cached: a transition's parameters are evaluated
 * when it runs, so a setting changed mid-session takes effect on the next open
 * without a reload.
 */
function reduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Mirrors the duration tokens, zeroed when reduced motion is on. */
export function duration(ms: number): number {
  return reduced() ? 0 : ms
}

export const DUR_FAST = 140
export const DUR_MID = 220
export const DUR_SLOW = 340

/**
 * A modal arriving: up a little, and up in scale a little.
 *
 * The rise is deliberately small. A dialog that flies in from off-screen draws
 * attention to the animation; one that lifts 12 px draws attention to itself
 * having arrived, which is the actual job.
 */
export function modalIn(node: Element): TransitionConfig {
  return fly(node, { y: 12, duration: duration(DUR_SLOW), easing: expoOut, opacity: 0 })
}

/**
 * A modal leaving. Faster and flatter than its entrance.
 *
 * Exits are shorter than entrances everywhere in this file. An entrance is
 * showing you something, so it can afford to be graceful; an exit is you having
 * already decided, and anything that lingers there feels like lag.
 */
export function modalOut(node: Element): TransitionConfig {
  return fly(node, { y: 6, duration: duration(DUR_FAST), easing: cubicIn, opacity: 0 })
}

/** The dimmed backdrop behind a modal. Opacity only — it has no shape to move. */
export function scrimIn(node: Element): TransitionConfig {
  return fade(node, { duration: duration(DUR_MID) })
}

export function scrimOut(node: Element): TransitionConfig {
  return fade(node, { duration: duration(DUR_FAST) })
}

/** A side panel sliding in from the right edge it is docked to. */
export function panelIn(node: Element): TransitionConfig {
  return fly(node, { x: 24, duration: duration(DUR_SLOW), easing: expoOut, opacity: 0 })
}

export function panelOut(node: Element): TransitionConfig {
  return fly(node, { x: 16, duration: duration(DUR_FAST), easing: cubicIn, opacity: 0 })
}

/**
 * A dropdown opening from the control that spawned it.
 *
 * Scales from 96% with a slight overshoot, anchored at its top edge by the
 * caller's `transform-origin`. The overshoot is what makes a menu feel like it
 * *popped* rather than faded — it is the one place in the app where a spring is
 * worth the attention it costs.
 */
export const MENU_IN: ScaleParams = {
  start: 0.96,
  opacity: 0,
  duration: DUR_MID,
  easing: backOut,
}

export function menuIn(node: Element): TransitionConfig {
  return scale(node, { ...MENU_IN, duration: duration(DUR_MID) })
}

export function menuOut(node: Element): TransitionConfig {
  return scale(node, { start: 0.98, opacity: 0, duration: duration(DUR_FAST), easing: cubicIn })
}

/**
 * A list item arriving as part of a group.
 *
 * `index` staggers the start so a grid resolves as a sweep rather than as one
 * simultaneous flash. Capped, because a 60-item watchlist staggered at 22 ms
 * would take a second and a third to finish drawing and the last rows would
 * visibly lag the scroll.
 */
export function stagger(index: number, step = 22, cap = 8): FlyParams {
  return {
    y: 8,
    opacity: 0,
    duration: duration(DUR_MID),
    delay: duration(Math.min(index, cap) * step),
    easing: expoOut,
  }
}
