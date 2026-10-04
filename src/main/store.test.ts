/**
 * The desktop's library reaches the disk before it takes the old one's place.
 *
 * The write goes to a temporary file that is renamed over the library. Without
 * a sync in between, a power cut can keep the rename and lose the data it
 * points at, leaving zeros or nothing where the library was; the next launch
 * then has to set it aside. ext4 and btrfs flush on such a rename by
 * themselves, NTFS promises nothing of the kind.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      calls.push('sync')
      fs.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      calls.push('rename')
      fs.renameSync(from, to)
    },
  }
})

const { NodePersistence } = await import('./store')

describe('writing the library on the desktop', () => {
  it('syncs the new file to the disk before renaming it over the library', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wta-store-'))
    try {
      const file = join(dir, 'watchthemall.json')
      await new NodePersistence(dir, file).write('{"schemaVersion":3}')

      expect(calls.slice(0, 2)).toEqual(['sync', 'rename'])
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ schemaVersion: 3 })
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
