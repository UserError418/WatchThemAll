/**
 * How far a running scan has got, as one line of text.
 *
 * Names what is under test instead of counting it. A scan tests several
 * sources at once, and a status line naming one of them — the old
 * "Testing VidLux (3 of 9)" — made a parallel scan read as one source after
 * another.
 */

import type { ScanInFlight } from '@shared/ipc'

/** "A", "A and B", "A, B and C". */
export function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * The status line for a running scan.
 *
 * The count is left off once every source has a verdict: only second tests of
 * reds remain by then, and "9 of 9 done" repeated while they run reads as
 * stuck.
 */
export function scanStatus(testing: readonly ScanInFlight[], done: number, total: number): string {
  if (testing.length === 0) return done === 0 ? 'Starting…' : `${done} of ${total} done`

  const first = testing.filter((test) => !test.recheck).map((test) => test.providerName)
  const second = testing.filter((test) => test.recheck).map((test) => test.providerName)
  const parts: string[] = []
  if (first.length > 0) parts.push(`Testing ${listOf(first)}`)
  if (second.length > 0) parts.push(`${parts.length > 0 ? 'double-checking' : 'Double-checking'} ${listOf(second)}`)

  const count = done < total ? ` · ${done} of ${total} done` : ''
  return `${parts.join(', ')}${count}`
}
