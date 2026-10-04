/**
 * Where the phone keeps the preview cache: the cache directory, which Android
 * may reclaim and backup leaves out, and no longer the data directory.
 */

import { expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    rmdir: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      calls.push(`rmdir ${directory}/${path}`)
    }),
    mkdir: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      calls.push(`mkdir ${directory}/${path}`)
    }),
    getUri: vi.fn(async ({ path, directory }: { path: string; directory: string }) => ({
      uri: `file:///data/user/0/app/${directory === 'CACHE' ? 'cache' : 'files'}/${path}`,
    })),
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (uri: string) => uri.replace('file://', 'https://localhost/_capacitor_file_') } }))
vi.mock('./cast', () => ({ capture: {} }))

const { phoneCacheFiles } = await import('./segmentfiles')

it('keeps windows in the cache directory, and empties the old copy in the data directory', async () => {
  const files = await phoneCacheFiles()

  expect(calls).toEqual(['rmdir DATA/preview-cache', 'mkdir CACHE/preview-cache'])
  expect(files.playlistUrl('w1')).toBe('https://localhost/_capacitor_file_/data/user/0/app/cache/preview-cache/w1/index.m3u8')
})
