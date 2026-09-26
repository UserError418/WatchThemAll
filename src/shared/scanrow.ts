/**
 * Facts about one stored row of test results, needed on both sides of `src/`.
 *
 * They lived in `main/providerscan.ts`, beside the only code that used them.
 * Test results from the user's other devices (`scanshare.ts`) are read by the
 * sync merge in `shared/store`, which cannot import from `main` — so the
 * lifetime and the per-provider test time moved here, and `providerscan.ts`
 * re-exports them for its existing callers. One definition of "how old is this
 * result" for both, because two would drift.
 */

import type { ProviderScan } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a test result is shown and used at all: thirty days.
 *
 * It was six hours, on the belief that these providers change by the hour.
 * Months of real use say they do not, and the owner set thirty days on
 * 2026-09-26. What keeps a month-old result honest is not expiry but
 * re-testing — see `RETEST_AFTER_MS` in `main/providerscan.ts` — and a real
 * play, which overrides an older red or amber (see `freshScan`).
 */
export const RESULT_TTL_MS = 30 * DAY_MS

/**
 * How many titles' results to keep.
 *
 * Bounded for the same reason the outcome log is: this is written on every test
 * and read on every ranking. Least recently updated go first. Two hundred
 * covers a long watchlist plus a month of titles scanned by hand, and stays
 * cheap to search linearly. The same bound holds for each other device's rows.
 */
export const MAX_SCANS = 200

/** When one provider in a row was tested, or null if it never was. */
export function testedAtOf(scan: ProviderScan, providerId: string): number | null {
  if (!(providerId in scan.verdicts)) return null
  // Rows stored before per-provider times existed were all tested at `at`.
  return scan.testedAt?.[providerId] ?? scan.at
}
