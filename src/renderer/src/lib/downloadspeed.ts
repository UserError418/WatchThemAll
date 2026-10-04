/**
 * How fast the running download goes and how long it has left, from the
 * statuses main publishes (about two a second while it runs). Measured over
 * the last `WINDOW_MS`, so a burst of three segments landing together does
 * not read as a spike, and a stall shows within that window.
 *
 * Time left comes from bytes when the size is estimated, else from segments
 * (a master with no bit rate gives no estimate until segments arrive).
 */

/** How far back the rate looks. */
export const WINDOW_MS = 15_000
/** Less than this between the first and last sample says nothing yet. */
const MIN_SPAN_MS = 2_000

interface Sample {
  at: number
  bytes: number
  segments: number
}

export interface SpeedReading {
  /** Bytes a second. */
  bytesPerSecond: number
  /** Seconds left, or null when it cannot be told yet. */
  secondsLeft: number | null
}

export class SpeedMeter {
  private id: string | null = null
  private samples: Sample[] = []

  /** One status of the running download. A different download, or fewer bytes (deleted, restarted), starts afresh. */
  observe(id: string, bytes: number, segments: number, at: number): void {
    const last = this.samples.at(-1)
    if (id !== this.id || (last !== undefined && bytes < last.bytes)) {
      this.id = id
      this.samples = []
    }
    if (last !== undefined && this.samples.length > 0 && last.at === at) return
    this.samples.push({ at, bytes, segments })
    this.samples = this.samples.filter((s) => at - s.at <= WINDOW_MS)
  }

  /** Nothing is running: the next download starts from nothing. */
  reset(): void {
    this.id = null
    this.samples = []
  }

  reading(remaining: { bytes: number | null; segments: number }): SpeedReading | null {
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (!first || !last || last.at - first.at < MIN_SPAN_MS) return null
    const seconds = (last.at - first.at) / 1000
    const bytesPerSecond = (last.bytes - first.bytes) / seconds
    const segmentsPerSecond = (last.segments - first.segments) / seconds
    let secondsLeft: number | null = null
    if (remaining.bytes !== null && bytesPerSecond > 0) secondsLeft = remaining.bytes / bytesPerSecond
    else if (segmentsPerSecond > 0) secondsLeft = remaining.segments / segmentsPerSecond
    return { bytesPerSecond, secondsLeft: secondsLeft === null ? null : Math.max(0, Math.round(secondsLeft)) }
  }
}

/** "4.2 MB/s", "640 KB/s". */
export function speedLabel(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`
  return `${Math.max(0, Math.round(bytesPerSecond / 1e3))} KB/s`
}

/** "about 12 min left", "less than a minute left", "1 h 05 min left". */
export function timeLeftLabel(seconds: number): string {
  if (seconds < 60) return 'less than a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min left`
  return `about ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min left`
}
