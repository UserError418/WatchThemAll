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
  /** The ids to enable, in order. */
  active: string[]
  /** The ids to record as offered. */
  known: string[]
  /** Whether either list differs from what was stored, and so needs writing. */
  changed: boolean
}

export function chooseActiveProviders(input: ActiveProviderInput): ActiveProviderDecision {
  const { stored, catalogue } = input
  const available = new Set(catalogue.map((p) => p.id))
  const core = catalogue.filter((p) => p.tier === 'core').map((p) => p.id)

  // Order is preserved: the stored list *is* the fallback order, and the user
  // can rearrange it.
  const surviving = stored.filter((id) => available.has(id))

  const known = input.known ?? []
  const seen = new Set(known)
  const unseenCore = core.filter((id) => !seen.has(id) && !surviving.includes(id))

  const active = surviving.length ? [...surviving, ...unseenCore] : core
  const nextKnown = catalogue.map((p) => p.id)

  const changed =
    surviving.length !== stored.length ||
    unseenCore.length > 0 ||
    nextKnown.length !== known.length ||
    nextKnown.some((id) => !seen.has(id))

  return { active, known: nextKnown, changed }
}
