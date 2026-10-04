/**
 * The downloads, as the renderer holds them: main's last `DownloadsStatus`,
 * replaced whenever main announces a change. Every surface that shows a
 * download (the Downloads page, the detail view's button, the episode rows,
 * the nav's indicator, Settings) reads this one copy, so they always agree.
 *
 * `status` stays null where the platform has no downloads (the phone, for
 * now), and every download control is then left out.
 */

import type { DownloadRequest, DownloadsStatus, DownloadView, QualityCap } from '@shared/ipc'
import { isOf } from '@shared/downloads/records'
import type { DownloadWhere } from '@shared/downloads/types'
import { toast } from './toast.svelte'
import { downloadEvents, eventMessage, isUnderWay } from './downloads'

class Downloads {
  status = $state.raw<DownloadsStatus | null>(null)
  private started = false

  /** Ask for the status once and follow it from then on. Called by the app shell. */
  start(): void {
    if (this.started) return
    this.started = true
    window.wta.on.downloads((status) => this.receive(status))
    void window.wta.downloads
      .status()
      .then((status) => {
        if (status !== null && this.status === null) this.status = status
      })
      .catch(() => {})
  }

  private receive(next: DownloadsStatus): void {
    for (const event of downloadEvents(this.status?.downloads ?? null, next.downloads)) toast.show(eventMessage(event))
    this.status = next
  }

  get available(): boolean {
    return this.status !== null
  }

  get list(): DownloadView[] {
    return this.status?.downloads ?? []
  }

  /** The one running or waiting, for the nav's indicator. */
  get underWay(): DownloadView[] {
    return this.list.filter(isUnderWay)
  }

  /** The download of this episode (or film), whatever its state. */
  of(where: DownloadWhere): DownloadView | null {
    return this.list.find((d) => isOf(d, where)) ?? null
  }

  async download(request: DownloadRequest): Promise<void> {
    const result = await window.wta.downloads.start(request)
    if (!result.ok) toast.show(result.error)
  }

  pause(id: string): void {
    void window.wta.downloads.pause(id)
  }

  resume(id: string): void {
    void window.wta.downloads.resume(id)
  }

  remove(id: string): void {
    void window.wta.downloads.remove(id)
  }

  setQuality(quality: QualityCap): void {
    void window.wta.downloads.setQuality(quality)
  }
}

export const downloads = new Downloads()
