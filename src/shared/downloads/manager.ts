/**
 * The downloads queue: one download at a time, each from the preferred
 * download source or else the one Resume would choose (`sourceOrder`), the
 * next source when one cannot give the film, pause, resume and delete, and
 * carrying on after a restart. The same on both platforms; what differs is
 * `DownloadPlatform`.
 *
 * ## One download's life
 *
 * 1. **Capture.** The source is loaded hidden and pressed play, the way the
 *    source tests do (`DownloadPlatform.capture`); what its page fetched
 *    comes back and the hidden page is closed.
 * 2. **Plan.** `planDownload` finds the film's playlist in the capture,
 *    picks the rendition the quality cap allows, and holds its length to
 *    TMDB's runtime. A source that fails is refused with a reason and the
 *    next one is captured.
 * 3. **Transfer.** `runTransfer` fetches the segments with the captured
 *    headers into the download's folder. When the signed URLs expire (a 403
 *    halfway through a film is ordinary), the same source is captured again
 *    and the transfer resumes at the next missing segment.
 *
 * The plan is kept as `plan.json` beside the segments, so a run resumed
 * after a pause or a restart first tries the URLs it had (they often still
 * open) and only captures again when they do not.
 */

import type { CapturedRequest, StreamFetch } from '../streamfetch'
import { planDownload, readPlan, samePlan, PLAN_FILE, PLAYLIST_FILE, type DownloadPlan } from './plan'
import {
  afterRestart,
  downloadOf,
  EMPTY_DOWNLOADS,
  newRecord,
  nextInQueue,
  playableDownload,
  readDownloadsFile,
  usedBytes,
  writeDownloadsFile,
  type DownloadsFile,
} from './records'
import { runTransfer, type DownloadFiles } from './transfer'
import type { DownloadRecord, DownloadRequest, DownloadsStatus, DownloadSubject, DownloadWhere, QualityCap } from './types'

/** A source a download can come from, by id and by name. */
export interface DownloadSource {
  id: string
  name: string
}

/** What a platform supplies: hidden capture, HTTP with a source's headers, files, and telling the UI. */
export interface DownloadPlatform {
  /** `downloads.json`'s text, or null when there is none yet. */
  readRecords(): Promise<string | null>
  /** Replace `downloads.json`, atomically. */
  writeRecords(text: string): Promise<void>
  /**
   * The sources to try, best first, as Resume would choose them: the one
   * chosen by hand for the title, then the best tested. Enabled ones only.
   * The preferred download source goes in front of these (`sourceOrder`).
   */
  sources(subject: DownloadSubject, preferredProviderId: string | null): Promise<DownloadSource[]>
  /**
   * Load the source hidden, press play, let it fetch for a few seconds, and
   * return the requests its page made (newest first) with the headers they
   * were made with. Empty when it streamed nothing. The page is gone when
   * this resolves.
   */
  capture(subject: DownloadSubject, source: DownloadSource): Promise<readonly CapturedRequest[]>
  /** Fetching playlists with a source's headers. */
  fetch: StreamFetch
  /** A download's folder, created when it does not exist. */
  folder(id: string): Promise<DownloadFiles>
  removeFolder(id: string): Promise<void>
  /** The download folders on disk, by name. */
  listFolders(): Promise<string[]>
  /** Free space where downloads are kept; null when it cannot be told. */
  freeBytes(): Promise<number | null>
  /** Fetch TMDB's poster into the folder, for offline use; its file name, or null when it could not be fetched. */
  savePoster(id: string, posterPath: string): Promise<string | null>
  /** Where the renderer loads a download's poster from. */
  posterUrl(id: string, file: string): string | null
  now(): number
  sleep(ms: number): Promise<void>
  /** The downloads changed: the UI's copy is replaced with this. */
  publish(status: DownloadsStatus): void
  log(line: string): void
}

export interface ManagerOptions {
  /** How often progress alone reaches the UI. State changes go at once. */
  publishEveryMs?: number
  /** How often progress alone is written to `downloads.json`. The folder is the truth; this is for the page. */
  saveEveryMs?: number
}

/** Captures of one source after its URLs expired, before the download gives up. */
const MAX_RECAPTURES = 4

/** Room kept free beyond the estimate: the estimate is a bit rate times a length, not a promise. */
const ROOM_MARGIN = 1.05

export function describeBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

export type StartResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * The order a download tries its sources in:
 *
 * 1. **The source of the stream on disk**, when part of one is there. A fresh
 *    capture of it is the likeliest to be the same stream, and only the same
 *    stream's segments join the ones kept; any other would start the film over.
 * 2. **The preferred download source** (the owner, 2026-10-07: the Downloads
 *    tab's dropdown), always tried, even where the source tests say it does
 *    not play this title: the capture is the real test, and "preferred" that
 *    gives way to a stale test result would not mean anything.
 * 3. **The platform's order**, unchanged: the source chosen by hand for the
 *    title, then Automatic's.
 *
 * Nothing outside `chain` is tried. It holds the enabled providers that can
 * serve this title, so a preferred source switched off since is passed over:
 * a provider switched off in the Providers panel is never reached.
 */
export function sourceOrder(
  chain: readonly DownloadSource[],
  preferredSourceId: string | null,
  onDisk: DownloadSource | null,
): DownloadSource[] {
  const first: DownloadSource[] = []
  for (const id of [onDisk?.id, preferredSourceId]) {
    const source = chain.find((s) => s.id === id)
    if (source !== undefined && !first.includes(source)) first.push(source)
  }
  return [...first, ...chain.filter((s) => !first.includes(s))]
}

export class DownloadManager {
  private file: DownloadsFile = { ...EMPTY_DOWNLOADS, downloads: [] }
  private active: { id: string; controller: AbortController; run: Promise<void> } | null = null
  private loaded = false
  private free: number | null = null
  private lastPublish = 0
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private lastSave = 0
  private writing: Promise<void> = Promise.resolve()
  private readonly publishEveryMs: number
  private readonly saveEveryMs: number

  constructor(
    private readonly platform: DownloadPlatform,
    options: ManagerOptions = {},
  ) {
    this.publishEveryMs = options.publishEveryMs ?? 500
    this.saveEveryMs = options.saveEveryMs ?? 3_000
  }

  /**
   * Read the records, put interrupted runs back in the queue (`afterRestart`),
   * remove folders no record names (a download deleted while the app was
   * closing, a damaged record), and start the queue.
   */
  async load(): Promise<void> {
    this.file = readDownloadsFile(await this.platform.readRecords())
    this.file.downloads = afterRestart(this.file.downloads)
    const known = new Set(this.file.downloads.map((r) => r.id))
    for (const folder of await this.platform.listFolders().catch(() => [])) {
      if (!known.has(folder)) await this.platform.removeFolder(folder).catch(() => {})
    }
    for (const record of this.file.downloads.filter((r) => r.state === 'done')) {
      const files = await this.platform.folder(record.id)
      const names = new Set((await files.list()).map((f) => f.name))
      if (!names.has(PLAYLIST_FILE)) this.patch(record.id, { state: 'failed', error: 'Its files are gone from this device' })
    }
    this.free = await this.platform.freeBytes().catch(() => null)
    this.loaded = true
    await this.save()
    this.publishNow()
    this.pump()
  }

  status(): DownloadsStatus {
    const downloads = [...this.file.downloads]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r, posterUrl: r.poster === null ? null : this.platform.posterUrl(r.id, r.poster) }))
    return {
      downloads,
      quality: this.file.quality,
      preferredSourceId: this.file.preferredSourceId,
      usedBytes: usedBytes(this.file.downloads),
      freeBytes: this.free,
    }
  }

  /** The download of this episode (or film), whatever its state. */
  find(where: DownloadWhere): DownloadRecord | null {
    return downloadOf(this.file.downloads, where)
  }

  /** The finished download of this episode: what the player plays in a source's place. */
  playable(where: DownloadWhere): DownloadRecord | null {
    return playableDownload(this.file.downloads, where)
  }

  /**
   * Ask for a download. One per episode: asking again for one that stopped
   * resumes it, and for one under way or done changes nothing.
   */
  async start(request: DownloadRequest): Promise<StartResult> {
    const { providerId, ...subject } = request
    if (subject.type === 'tv' && (subject.season === null || subject.episode === null)) {
      return { ok: false, error: 'Choose an episode to download' }
    }
    const existing = this.find(subject)
    if (existing) {
      if (existing.state === 'paused' || existing.state === 'failed') await this.resume(existing.id)
      return { ok: true, id: existing.id }
    }
    const record = newRecord(subject, providerId, this.platform.now())
    this.file.downloads.push(record)
    await this.changed('state')
    this.pump()
    return { ok: true, id: record.id }
  }

  /** Stop a download where it is; its segments stay. The run in flight ends at its next segment. */
  async pause(id: string): Promise<void> {
    const record = this.record(id)
    if (!record || record.state === 'done' || record.state === 'paused') return
    this.patch(id, { state: 'paused' })
    if (this.active?.id === id) this.active.controller.abort()
    await this.changed('state')
  }

  /** Back into the queue, as a fresh attempt: sources refused last time are tried again. */
  async resume(id: string): Promise<void> {
    const record = this.record(id)
    if (!record || (record.state !== 'paused' && record.state !== 'failed')) return
    this.patch(id, { state: 'queued', refusals: [], error: null })
    await this.changed('state')
    this.pump()
  }

  /** Delete a download and its files, finished or not. */
  async remove(id: string): Promise<void> {
    if (!this.record(id)) return
    this.file.downloads = this.file.downloads.filter((r) => r.id !== id)
    await this.changed('state')
    // The run writes into the folder until it stops; deleting under it would
    // leave the files it writes after.
    if (this.active?.id === id) {
      this.active.controller.abort()
      await this.active.run
    }
    await this.platform.removeFolder(id).catch((error: unknown) => this.platform.log(`could not delete ${id}: ${String(error)}`))
    this.free = await this.platform.freeBytes().catch(() => this.free)
    this.publishNow()
  }

  /** The Settings choice. Applies to downloads planned from now on. */
  async setQuality(quality: QualityCap): Promise<void> {
    this.file.quality = quality
    await this.changed('state')
  }

  /**
   * The Downloads tab's choice; null for Automatic. Applies whenever a
   * download next chooses a source: one starting, and one resumed with
   * nothing on disk. A download part-way through keeps its own stream.
   */
  async setPreferredSource(providerId: string | null): Promise<void> {
    this.file.preferredSourceId = providerId
    await this.changed('state')
  }

  private record(id: string): DownloadRecord | null {
    return this.file.downloads.find((r) => r.id === id) ?? null
  }

  /** Change a record in memory; nothing when it was deleted meanwhile. */
  private patch(id: string, change: Partial<DownloadRecord>): void {
    this.file.downloads = this.file.downloads.map((r) => (r.id === id ? { ...r, ...change, updatedAt: this.platform.now() } : r))
  }

  /**
   * Write the file: one write at a time, each of the records as they are when
   * its turn comes. Two at once raced over the platform's temporary file
   * (measured on the desktop: a progress save and a state save overlapped,
   * and one rename failed with ENOENT).
   */
  private save(): Promise<void> {
    this.lastSave = this.platform.now()
    this.writing = this.writing.then(() =>
      this.platform.writeRecords(writeDownloadsFile(this.file)).catch((error: unknown) => {
        this.platform.log(`could not write the downloads file: ${String(error)}`)
      }),
    )
    return this.writing
  }

  private publishNow(): void {
    if (this.publishTimer !== null) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.lastPublish = this.platform.now()
    this.platform.publish(this.status())
  }

  /** Tell the UI and write the file: at once for a state change, at most every so often for progress. */
  private async changed(kind: 'state' | 'progress'): Promise<void> {
    const now = this.platform.now()
    if (kind === 'state' || now - this.lastPublish >= this.publishEveryMs) this.publishNow()
    else this.publishTimer ??= setTimeout(() => this.publishNow(), this.publishEveryMs - (now - this.lastPublish))
    if (kind === 'state' || now - this.lastSave >= this.saveEveryMs) await this.save()
  }

  /** Start the next queued download when none is running. */
  private pump(): void {
    if (!this.loaded || this.active !== null) return
    const next = nextInQueue(this.file.downloads)
    if (next === null) return
    const controller = new AbortController()
    const run = this.run(next.id, controller.signal)
      .catch(async (error: unknown) => {
        this.platform.log(`download ${next.id} stopped: ${String(error)}`)
        if (this.record(next.id)?.state !== 'paused') this.patch(next.id, { state: 'failed', error: 'Something went wrong; try again' })
        await this.changed('state')
      })
      .finally(() => {
        this.active = null
        this.pump()
      })
    this.active = { id: next.id, controller, run }
  }

  private async fail(id: string, error: string): Promise<void> {
    this.patch(id, { state: 'failed', error })
    await this.changed('state')
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const first = this.record(id)
    if (!first) return
    const { subject } = first
    const files = await this.platform.folder(id)

    if (first.poster === null && subject.posterPath !== null) {
      const poster = await this.platform.savePoster(id, subject.posterPath).catch(() => null)
      if (poster !== null) this.patch(id, { poster })
    }

    let plan: DownloadPlan | null = readPlan(await files.readText(PLAN_FILE))
    // A plan from an earlier run: its URLs first, since they often still open.
    let useKept = plan !== null
    const chain = await this.platform.sources(subject, first.preferredProviderId)
    const pending = sourceOrder(chain, this.file.preferredSourceId, plan !== null ? first.source : null)
    if (pending.length === 0 && !useKept) return this.fail(id, 'No enabled source can play this')
    let recaptures = 0

    for (;;) {
      if (signal.aborted || !this.record(id)) return
      const refused = new Set(this.record(id)!.refusals.map((r) => r.providerId))

      // Whether this round's plan comes from a capture just made, rather than from disk.
      const captured = !useKept
      if (!useKept) {
        const source = pending.shift()
        if (!source) {
          const reasons = this.record(id)!.refusals.map((r) => r.reason)
          return this.fail(id, reasons.length > 0 ? reasons.join('; ') : 'No enabled source can play this')
        }
        if (refused.has(source.id)) continue
        this.patch(id, { state: 'capturing', source, error: null })
        await this.changed('state')
        const requests = await this.platform.capture(subject, source).catch(() => [])
        if (signal.aborted || !this.record(id)) return
        const planned = await planDownload(requests, this.platform.fetch, {
          expectedMinutes: subject.runtimeMinutes,
          cap: this.file.quality,
          sourceName: source.name,
          kind: subject.type === 'movie' ? 'film' : 'episode',
        })
        if (signal.aborted || !this.record(id)) return
        if (!planned.ok) {
          this.platform.log(`${id}: ${planned.reason}`)
          this.patch(id, { refusals: [...this.record(id)!.refusals, { providerId: source.id, reason: planned.reason }] })
          continue
        }
        if (plan !== null && !samePlan(plan, planned.plan)) {
          // Another stream than the one on disk: its segments would not join
          // the ones kept, so the download starts over with this one.
          for (const file of await files.list()) if (file.name !== this.record(id)!.poster) await files.remove(file.name)
        }
        plan = planned.plan
        await files.writeText(PLAN_FILE, JSON.stringify(plan))
      }
      useKept = false
      if (plan === null) continue

      this.patch(id, {
        state: 'downloading',
        format: plan.format,
        height: this.record(id)!.height ?? plan.height,
        durationSeconds: plan.totalSeconds,
        segmentsTotal: plan.segments.length,
      })
      await this.changed('state')
      /** Segments in the folder when this transfer started, and whether it added any. */
      let startedWith: number | null = null
      let progressed = false
      /** The refusal was the disk's, not the source's. */
      let noRoom = false
      const outcome = await runTransfer(plan, files, {
        signal,
        sleep: (ms) => this.platform.sleep(ms),
        onProgress: (progress) => {
          startedWith ??= progress.segmentsDone
          if (progress.segmentsDone > startedWith) progressed = true
          this.patch(id, {
            segmentsDone: progress.segmentsDone,
            segmentsTotal: progress.segmentsTotal,
            bytesDone: progress.bytesDone,
            estimatedBytes: progress.estimatedBytes,
          })
          void this.changed('progress')
        },
        roomFor: async (bytes) => {
          const needed = bytes * ROOM_MARGIN
          this.free = await this.platform.freeBytes().catch(() => null)
          if (this.free === null || this.free >= needed) return null
          noRoom = true
          return `Not enough space on this device: it needs ${describeBytes(needed)}, ${describeBytes(this.free)} is free`
        },
      })
      if (!this.record(id)) return

      switch (outcome.kind) {
        case 'done':
          this.patch(id, {
            state: 'done',
            bytesDone: outcome.bytes,
            height: outcome.height ?? this.record(id)!.height,
            segmentsDone: plan.segments.length,
            error: null,
            finishedAt: this.platform.now(),
          })
          this.free = await this.platform.freeBytes().catch(() => this.free)
          await this.changed('state')
          return
        case 'aborted':
          await this.changed('state')
          return
        case 'failed': {
          const source = this.record(id)!.source
          if (captured && !progressed && !noRoom && source !== null) {
            // Nothing of a stream just captured would download: the source's
            // stream, not the network (measured: a proxy serving the segments
            // mangled into text). The next source may well give the film.
            this.patch(id, { refusals: [...this.record(id)!.refusals, { providerId: source.id, reason: `${source.name}: ${outcome.reason}` }] })
            continue
          }
          if (!captured && !progressed && !noRoom) {
            // The URLs kept from an earlier run gave nothing: a stream its
            // source was refused for (its plan stays on disk when every source
            // after it refuses too), or one no longer served. Failing here
            // failed every resume the same way, without a capture (found
            // 2026-10-07), so capture afresh. `plan` stays as it is, so a
            // fresh capture of the same stream keeps the segments on disk.
            this.platform.log(`${id}: the kept stream gave nothing (${outcome.reason}), capturing again`)
            continue
          }
          return this.fail(id, outcome.reason)
        }
        case 'expired': {
          const source = this.record(id)!.source
          if (captured && !progressed && source !== null) {
            // Refused straight after a fresh capture: not links that aged, a
            // stream that will not be fetched outside its player (measured: a
            // CDN answering "domain forbidden" to the player's own headers).
            // Capturing it again would only find the same stream.
            this.patch(id, { refusals: [...this.record(id)!.refusals, { providerId: source.id, reason: `${source.name}'s stream refused the download` }] })
            continue
          }
          recaptures += 1
          if (recaptures > MAX_RECAPTURES || source === null) return this.fail(id, `${source?.name ?? 'The source'}'s links kept expiring`)
          this.platform.log(`${id}: links expired, capturing ${source.name} again`)
          pending.unshift(source)
          continue
        }
      }
    }
  }
}
