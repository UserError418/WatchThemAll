/**
 * Which providers are switched on, given what is stored and what is offered.
 *
 * Pulled out of `library.load()` and made pure because it has now been wrong
 * twice, and both times silently: the app kept running, looked healthy, and
 * simply played nothing — or played through a provider list the user did not
 * choose. There is nothing here a type checker or a linter can catch, so the
 * only way to hold it is with tests.
 *
 * Three situations arrive at this function and they must be told apart:
 *
 * 1. **A first run.** Nothing is stored. Enable the catalogue's `core` tier,
 *    because pressing play has to work before the user has opened settings.
 * 2. **The catalogue dropped ids the user had enabled.** Providers die; eight
 *    were removed at once when measurement showed they could not stream. If the
 *    stored list resolves to nothing, every play fails with "no providers are
 *    enabled" on an app that worked yesterday, so fall back to core.
 * 3. **The catalogue gained a `core` id the user has never been offered.** This
 *    is the one that needs `known`. A non-empty stored list is otherwise taken
 *    as the user's considered choice, so a newly added provider reaches nobody
 *    with an existing install — which is everybody except a fresh one.
 *
 * The distinction that makes (3) work is between *switched off* and *never
 * seen*. `active` alone renders both as absent.
 *
 * One rule holds across all three since 2.0.12: **the stored lists only
 * grow.** Two devices can hold different catalogues for hours (each refreshes
 * on its own clock, and a phone may run an older build). When this dropped
 * the ids its catalogue lacked and rewrote `known` to exactly its own
 * catalogue, the other device took that, saw a dropped core id as never
 * offered and switched it back on: a provider the user had switched off came
 * back, one they had switched on in the extras went away, and both devices
 * rewrote the lists on every sync. Ids this catalogue lacks now stay stored;
 * what cannot play here is left out where the list is used
 * (`enabledProviders` on both platforms, the source pickers), and the core
 * fallback of case (2) is for this device's eyes only.
 */

import type { Provider } from '@shared/types'

export interface ActiveProviderInput {
  /** The provider ids stored as enabled, in the user's order. */
  stored: string[]
  /**
   * Every provider id this install has been offered.
   *
   * Absent on an install predating the field, which is treated as "has been
   * offered nothing" — so every core provider counts as new. That is the right
   * reading: the field's absence means no record exists, not that the user
   * declined everything.
   */
  known: string[] | undefined
  /** The catalogue in force: bundled or managed, plus the user's own. */
  catalogue: Provider[]
}

export interface ActiveProviderDecision {
  /** The ids to treat as enabled here, in order: the stored list, or the core tier when nothing in it is in this catalogue. */
  active: string[]
  /** The list to store: what was stored plus any core provider never offered, never losing an id. */
  stored: string[]
  /** The ids to record as offered: everything offered so far, here or on another device. */
  known: string[]
  /** Whether `stored` or `known` differs from what was stored, and so needs writing. */
  changed: boolean
}

export function chooseActiveProviders(input: ActiveProviderInput): ActiveProviderDecision {
  const { stored, catalogue } = input
  const available = new Set(catalogue.map((p) => p.id))
  const core = catalogue.filter((p) => p.tier === 'core').map((p) => p.id)

  const known = input.known ?? []
  const seen = new Set(known)
  const unseenCore = core.filter((id) => !seen.has(id) && !stored.includes(id))

  // Order is preserved: the stored list *is* the fallback order, and the user
  // can rearrange it. Ids this catalogue lacks stay in it; see the header.
  const nextStored = [...stored, ...unseenCore]
  const nextKnown = [...known, ...catalogue.map((p) => p.id).filter((id) => !seen.has(id))]
  const active = nextStored.some((id) => available.has(id)) ? nextStored : core

  return {
    active,
    stored: nextStored,
    known: nextKnown,
    changed: unseenCore.length > 0 || nextKnown.length !== known.length,
  }
}
