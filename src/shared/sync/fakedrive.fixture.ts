/**
 * Google Drive in memory, for the sync tests.
 *
 * It answers the requests `drive.ts` makes (a listing by name, a download, an
 * upload) the way Drive does, checksum included, so a test runs the real
 * backend rather than a stand-in for it. Two more abilities are what the tests
 * need it for: a listing can be held open until the test releases it, which
 * is how a write is put into the middle of a sync, and the next answer can be
 * made a failure, for the error handling.
 */

import { StoreCore, type StorePersistence } from '../store/core'
import type { StoreDocument } from '../store/document'
import { migrate } from '../store/migrate'
import type { DeviceKind } from '../types'
import type { FetchLike } from './devicecode'
import { createDriveBackend } from './drive'
import type { SyncHost } from './engine'
import type { SyncBackend } from './types'

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

interface StoredFile {
  id: string
  name: string
  text: string
  /** Creation order, for `orderBy=createdTime`. */
  created: number
}

/** Any stable digest will do: the backend only ever compares two checksums. */
function checksum(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}-${text.length}`
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export class FakeDrive {
  /** Every request, in order, as `METHOD url`. */
  readonly requests: string[] = []
  uploads = 0
  downloads = 0

  private readonly files = new Map<string, StoredFile>()
  private created = 0
  private readonly holds: Array<{ asked: () => void; released: Promise<void> }> = []
  private readonly failures: Array<{ status: number; reason?: string }> = []

  /** Put a file there, as another device's earlier push would have. */
  seed(name: string, document: unknown): void {
    this.add(name, JSON.stringify(document))
  }

  /** The text of the file of that name; the oldest, if there are several. */
  file(name: string): string {
    const file = this.named(name)[0]
    if (file === undefined) throw new Error(`no file named ${name}`)
    return file.text
  }

  /** How many files have that name. */
  count(name: string): number {
    return this.named(name).length
  }

  /** The next listing waits for `release()`; `asked` resolves once it has been requested. */
  holdNextListing(): { asked: Promise<void>; release: () => void } {
    let asked!: () => void
    let release!: () => void
    const askedPromise = new Promise<void>((resolve) => (asked = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    this.holds.push({ asked, released })
    return { asked: askedPromise, release }
  }

  /** The next request is answered with this status and, when given, Drive's reason. */
  failNext(status: number, reason?: string): void {
    this.failures.push({ status, reason })
  }

  /** The real backend, on this Drive. */
  backend<T = StoreDocument>(name?: string): SyncBackend<T> {
    return createDriveBackend<T>({ accessToken: () => Promise.resolve('token'), fetchImpl: this.fetch, name })
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init.method ?? 'GET'
    this.requests.push(`${method} ${url}`)

    const failure = this.failures.shift()
    if (failure !== undefined) {
      const errors = failure.reason === undefined ? [] : [{ reason: failure.reason }]
      return answer({ error: { code: failure.status, message: 'refused by the test', errors } }, failure.status)
    }

    if (method === 'GET' && url.startsWith(`${FILES_URL}?`)) {
      const hold = this.holds.shift()
      if (hold !== undefined) {
        hold.asked()
        await hold.released
      }
      const params = new URL(url).searchParams
      const name = /name = '([^']+)'/.exec(params.get('q') ?? '')?.[1] ?? ''
      // Without an order Drive promises none; newest first stands in for that,
      // so a test can tell whether the backend asked for one.
      const files = this.named(name)
      if (params.get('orderBy') !== 'createdTime') files.reverse()
      return answer({ files: files.map((f) => ({ id: f.id, md5Checksum: checksum(f.text) })) })
    }

    if (method === 'GET' && url.startsWith(`${FILES_URL}/`) && url.includes('alt=media')) {
      this.downloads += 1
      const file = this.files.get(url.slice(FILES_URL.length + 1).split('?')[0]!)
      return file === undefined ? answer({}, 404) : new Response(file.text, { status: 200 })
    }

    if (method === 'PATCH' && url.startsWith(`${UPLOAD_URL}/`)) {
      this.uploads += 1
      const file = this.files.get(url.slice(UPLOAD_URL.length + 1).split('?')[0]!)
      if (file === undefined) return answer({}, 404)
      file.text = String(init.body)
      return answer({ id: file.id, md5Checksum: checksum(file.text) })
    }

    if (method === 'POST' && url.startsWith(`${UPLOAD_URL}?`)) {
      this.uploads += 1
      // The multipart body `drive.ts` builds: metadata first, then the document.
      const parts = String(init.body).split(/--wta-[a-z0-9]+/)
      const metadata = JSON.parse(parts[1]!.split('\r\n\r\n')[1]!.trim()) as { name: string }
      const text = parts[2]!.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
      const file = this.add(metadata.name, text)
      return answer({ id: file.id, md5Checksum: checksum(file.text) })
    }

    throw new Error(`the fake Drive does not answer ${method} ${url}`)
  }

  private add(name: string, text: string): StoredFile {
    this.created += 1
    const file = { id: `file-${this.created}`, name, text, created: this.created }
    this.files.set(file.id, file)
    return file
  }

  /** Files of that name, oldest first. */
  private named(name: string): StoredFile[] {
    return [...this.files.values()].filter((f) => f.name === name).sort((a, b) => a.created - b.created)
  }
}

/** A document file in memory: the store's persistence for these tests. */
export class MemoryFile implements StorePersistence {
  text: string | null = null

  read(): Promise<string | null> {
    return Promise.resolve(this.text)
  }

  write(text: string): Promise<void> {
    this.text = text
    return Promise.resolve()
  }

  quarantine(): Promise<void> {
    return Promise.resolve()
  }
}

/** A loaded store for one kind of device, kept in memory. */
export async function storeOn(kind: DeviceKind, file: StorePersistence = new MemoryFile()): Promise<StoreCore> {
  const store = new StoreCore(file, migrate, kind)
  await store.load()
  return store
}

/** The library's sync host, as both platforms build it: the whole document, tombstones included. */
export function libraryHost(store: StoreCore): SyncHost {
  return { read: () => store.raw(), write: (document) => store.replaceDocument(document) }
}
