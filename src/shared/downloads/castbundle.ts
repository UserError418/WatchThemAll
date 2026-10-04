/**
 * Casting a download (the owner, 2026-10-04): its local playlist, rewritten
 * so the cast proxy can serve it to a television from disk.
 *
 * A stream from a source is cast by capturing what its player fetched and
 * proxying it (`hlsrewrite.ts`). A download has nothing to capture: the
 * player reads files. So every file the playlist names (segments and
 * initialisation segments) gets an unguessable id, the playlist is rewritten
 * to name the ids, and the proxy serves each id from its file. As for a
 * source's stream, no route takes a path: only the ids registered here are
 * answered, for as long as the cast runs.
 */

/** Ids a device on the network cannot guess; `unguessableId` in `hlsrewrite.ts`. */
export type IdMaker = (prefix: string) => string

export interface DownloadCastBundle {
  /** The playlist's id; the receiver is handed `<base><rootId>.m3u8`. */
  rootId: string
  /** id -> rewritten playlist, served from memory. */
  playlists: Record<string, string>
  /** id -> file name inside the download's folder. */
  files: Record<string, string>
}

/** The names a download's playlist may use: its own making, never a path. */
const FILE_NAME = /^[a-z0-9]+\.(ts|m4s|mp4)$/

/**
 * Null when the playlist names something other than a file of the
 * download's own (it is ours, so that means it is damaged, and serving it
 * would mean reading whatever it names).
 */
export function downloadCastBundle(playlist: string, newId: IdMaker): DownloadCastBundle | null {
  const files: Record<string, string> = {}
  const idOf = new Map<string, string>()
  const idFor = (name: string): string | null => {
    if (!FILE_NAME.test(name)) return null
    let id = idOf.get(name)
    if (id === undefined) {
      id = newId('f')
      idOf.set(name, id)
      files[id] = name
    }
    return id
  }

  const lines: string[] = []
  for (const line of playlist.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]*)"/.exec(trimmed)?.[1]
      const id = uri === undefined ? null : idFor(uri)
      if (id === null) return null
      lines.push(trimmed.replace(/URI="[^"]*"/, `URI="${id}"`))
    } else if (trimmed === '' || trimmed.startsWith('#')) {
      lines.push(trimmed)
    } else {
      const id = idFor(trimmed)
      if (id === null) return null
      lines.push(id)
    }
  }
  if (Object.keys(files).length === 0) return null
  const rootId = newId('p')
  return { rootId, playlists: { [rootId]: lines.join('\n') }, files }
}
