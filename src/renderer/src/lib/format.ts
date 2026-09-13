/**
 * Display formatting. Pure functions, no DOM — so they are testable, and so
 * the same string is produced everywhere a value appears.
 */

/** `S02E05`. The zero padding is what makes a column of these line up. */
export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

/** `2024` from a TMDB `YYYY-MM-DD`, or an empty string. */
export function year(date: string | null | undefined): string {
  return date?.slice(0, 4) ?? ''
}

/** `12 Mar 2024`, in the user's locale, from a TMDB date string. */
export function airDate(date: string | null | undefined): string {
  if (!date) return ''
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** `1h 22m`, `47m`, or an empty string. */
export function runtime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest}m`
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/**
 * A position on a timeline: `4:07`, `1:23:45`.
 *
 * Distinct from `runtime` on purpose. That one describes a length in the prose
 * of a catalogue — "1h 22m" — while this one is read against a moving scrubber,
 * where the eye wants fixed columns and a leading hour only when there is one.
 * Rounds down, because a position that reads 4:08 while the seek lands on 4:07
 * looks like the seek missed.
 */
export function clock(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return '0:00'
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/** `3d 4h`, `4h 12m`, `12m`, `Airing now`, or an empty string. */
export function countdown(date: string | null | undefined, now = Date.now()): string {
  if (!date) return ''
  const target = new Date(`${date}T00:00:00`).getTime()
  if (Number.isNaN(target)) return ''

  const diff = target - now
  if (diff <= 0) return 'Airing now'

  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** `just now`, `12m ago`, `3h ago`, `5d ago`, then an absolute date. */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(timestamp).toLocaleDateString()
}

/** True when a TMDB air date is today or in the past. */
export function hasAired(date: string | null | undefined, now = Date.now()): boolean {
  if (!date) return false
  const target = new Date(`${date}T00:00:00`).getTime()
  return !Number.isNaN(target) && target <= now
}
