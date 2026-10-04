/**
 * What a source's page fetched, and fetching it again with the same headers.
 * Shared by the preview cache (`main/segmentsave.ts`) and downloads
 * (`shared/downloads/`), on both platforms: the desktop captures requests
 * with `castcapture.ts` or a probe's `onResponse`, the phone with
 * `MediaCapture.java`.
 */

/** A request the source's page made, with the headers it was made with. */
export interface CapturedRequest {
  url: string
  headers: Record<string, string>
}

/** Fetching with a source's headers, which the page's own origin could not send. */
export interface StreamFetch {
  /**
   * A URL's text, fetched with these headers; null when it could not be
   * reached. `limitBytes`: only the start of it. Candidates are sniffed that
   * way, since most are segments of several megabytes.
   */
  fetchText(url: string, headers: Record<string, string>, limitBytes?: number): Promise<{ status: number; body: string } | null>
}
