/**
 * The phone's persistence against a fake of the Filesystem plugin that renames
 * the way Android's does: delete the destination, then rename onto it. A
 * process killed between the two must not cost the library.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const files = new Map<string, string>()
/** Set to make the next rename die after its delete, as a killed process would. */
let killDuringRename = false

const missing = (path: string): Error =>
  Object.assign(new Error(`File ${path} does not exist`), { code: 'OS-PLUG-FILE-0008' })

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const data = files.get(path)
      if (data === undefined) throw missing(path)
      return { data }
    }),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      files.set(path, data)
    }),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const data = files.get(from)
      if (data === undefined) throw missing(from)
      files.delete(to)
      if (killDuringRename) {
        killDuringRename = false
        throw new Error('process killed')
      }
      files.set(to, data)
      files.delete(from)
    }),
  },
}))

const { CapacitorPersistence } = await import('./store')

beforeEach(() => {
  files.clear()
  killDuringRename = false
})

it('takes the library back from a write killed inside the rename', async () => {
  files.set('watchthemall.json', '{"watchlist":["old"]}')
  killDuringRename = true
  await expect(new CapacitorPersistence('watchthemall.json').write('{"watchlist":["new"]}')).rejects.toThrow()
  expect(files.has('watchthemall.json')).toBe(false)

  // The next launch.
  const text = await new CapacitorPersistence('watchthemall.json').read()

  expect(text).toBe('{"watchlist":["new"]}')
  expect(files.get('watchthemall.json')).toBe('{"watchlist":["new"]}')
  expect(files.has('watchthemall.json.tmp')).toBe(false)
})

it('does not take a temporary file cut off mid-write for the library', async () => {
  files.set('watchthemall.json.tmp', '{"watchlist":["ha')

  expect(await new CapacitorPersistence('watchthemall.json').read()).toBeNull()
})

it('prefers the library to a temporary file left beside it', async () => {
  files.set('watchthemall.json', '{"watchlist":["saved"]}')
  files.set('watchthemall.json.tmp', '{"watchlist":["half-saved"]}')

  expect(await new CapacitorPersistence('watchthemall.json').read()).toBe('{"watchlist":["saved"]}')
})

it('reads a missing library with no temporary file as missing', async () => {
  expect(await new CapacitorPersistence('watchthemall.json').read()).toBeNull()
})
