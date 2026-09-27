/**
 * The Drive backend's requests: how few it makes, and that saving one never
 * costs a stale document.
 *
 * Against a small fake of the three Drive calls it uses. The checksum is a
 * real MD5, as Drive's is, so "same content, same checksum" holds here too.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createDriveBackend } from './drive'
import type { StoreDocument } from '../store/document'

const md5 = (text: string): string => createHash('md5').update(text).digest('hex')

/** A document is opaque to the backend; any JSON stands in for one. */
const doc = (marker: string): StoreDocument => ({ marker }) as unknown as StoreDocument

interface FakeFile {
  id: string
  text: string
}

function fakeDrive(options: { reportChecksums?: boolean } = {}) {
  const { reportChecksums = true } = options
  const drive = {
    file: null as FakeFile | null,
    created: 0,
    calls: [] as string[],
    /** Another device writing the file. */
    writeElsewhere(text: string): void {
      if (drive.file) drive.file = { ...drive.file, text }
    },
  }

  const describeFile = (file: FakeFile) => ({ id: file.id, ...(reportChecksums ? { md5Checksum: md5(file.text) } : {}) })
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
  const notFound = (): Response => new Response('{}', { status: 404 })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const last = url.pathname.split('/').pop()!

    if (method === 'GET' && url.searchParams.has('q')) {
      drive.calls.push('list')
      return json({ files: drive.file ? [describeFile(drive.file)] : [] })
    }
    if (method === 'GET' && url.searchParams.get('alt') === 'media') {
      drive.calls.push('download')
      return drive.file?.id === last ? new Response(drive.file.text, { status: 200 }) : notFound()
    }
    if (method === 'PATCH') {
      drive.calls.push('update')
      if (drive.file?.id !== last) return notFound()
      drive.file = { id: last, text: String(init?.body) }
      return json(describeFile(drive.file))
    }
    if (method === 'POST') {
      drive.calls.push('create')
      // The content is the multipart body's second part.
      const text = String(init?.body).split('\r\n\r\n')[2]!.split('\r\n')[0]!
      drive.created += 1
      drive.file = { id: `file-${drive.created}`, text }
      return json(describeFile(drive.file))
    }
    throw new Error(`unexpected ${method} ${url}`)
  }) as typeof fetch

  const backend = createDriveBackend({ accessToken: async () => 'token', fetchImpl })
  return { drive, backend }
}

describe('createDriveBackend', () => {
  /** The common case: nothing happened elsewhere since this device's last sync. */
  it('does not download a file whose checksum has not moved', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }

    const first = await backend.pull()
    const second = await backend.pull()

    expect(drive.calls).toEqual(['list', 'download', 'list'])
    expect(second).toEqual(first)
  })

  it('downloads again once another device has written', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }
    await backend.pull()

    drive.writeElsewhere(JSON.stringify(doc('two')))
    const pulled = await backend.pull()

    expect(pulled?.document).toEqual(doc('two'))
    expect(drive.calls.filter((call) => call === 'download')).toHaveLength(2)
  })

  /** Its own upload is what the next sync finds, so that is not fetched back. */
  it('does not download what it just uploaded', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }
    await backend.pull()
    await backend.push(doc('merged'), null)
    drive.calls = []

    const pulled = await backend.pull()

    expect(drive.calls).toEqual(['list'])
    expect(pulled?.document).toEqual(doc('merged'))
  })

  it('lists once per sync, not again to push', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }

    await backend.pull()
    await backend.push(doc('merged'), null)

    expect(drive.calls).toEqual(['list', 'download', 'update'])
  })

  /** The stale-id case the per-sync listing exists to rule out. */
  it('creates the file afresh when it was deleted between pull and push', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }
    await backend.pull()

    drive.file = null
    await backend.push(doc('merged'), null)

    expect(drive.calls.slice(-2)).toEqual(['update', 'create'])
    expect(JSON.parse(drive.file!.text)).toEqual(doc('merged'))
  })

  it('creates the file on the first sync without listing twice', async () => {
    const { drive, backend } = fakeDrive()

    expect(await backend.pull()).toBeNull()
    await backend.push(doc('first'), null)

    expect(drive.calls).toEqual(['list', 'create'])
    expect(JSON.parse(drive.file!.text)).toEqual(doc('first'))
  })

  it('always downloads when Drive reports no checksum', async () => {
    const { drive, backend } = fakeDrive({ reportChecksums: false })
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }

    await backend.pull()
    await backend.pull()

    expect(drive.calls).toEqual(['list', 'download', 'list', 'download'])
  })

  /** The cached text is parsed afresh, so a caller editing what it got cannot alter the cache. */
  it('hands out a fresh document on every pull', async () => {
    const { drive, backend } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }

    const first = await backend.pull()
    ;(first!.document as unknown as { marker: string }).marker = 'edited'
    const second = await backend.pull()

    expect(second?.document).toEqual(doc('one'))
  })

  /** The upload succeeded; an unreadable answer must not fail the sync. */
  it('still counts a push whose answer it cannot read', async () => {
    const { drive } = fakeDrive()
    drive.file = { id: 'a', text: JSON.stringify(doc('one')) }
    const silent = createDriveBackend({
      accessToken: async () => 'token',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          drive.file = { id: 'a', text: String(init.body) }
          return new Response('', { status: 200 })
        }
        return new Response(JSON.stringify({ files: [{ id: 'a', md5Checksum: md5(drive.file!.text) }] }), { status: 200 })
      }) as typeof fetch,
    })

    await expect(silent.push(doc('merged'), null)).resolves.toBeUndefined()
    expect(JSON.parse(drive.file.text)).toEqual(doc('merged'))
  })
})

