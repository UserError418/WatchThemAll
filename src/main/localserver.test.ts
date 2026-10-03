/**
 * The local server's file answers, against a real server on a free port and
 * real files in a temporary directory.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A file the server is about to read that vanishes the moment it first
 * touches it: after looking at it, or just before opening it. That is a
 * preview window evicted (`rm -rf`) while the detail view's video asks for it.
 */
const evicted = vi.hoisted(() => ({ path: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const isEvicted = (file: unknown): boolean => evicted.path !== null && String(file) === evicted.path
  return {
    ...real,
    stat: async (file: string) => {
      const info = await real.stat(file)
      if (isEvicted(file)) await real.rm(file, { force: true })
      return info
    },
    open: async (file: string, flags?: string) => {
      if (isEvicted(file)) await real.rm(file, { force: true })
      return real.open(file, flags)
    },
  }
})

import { serveCacheFrom, startRendererServer, stopRendererServer } from './localserver'

const WINDOW = 'tv-tt0000001-1-1-abc'
let root = ''
let base = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wta-localserver-'))
  mkdirSync(join(root, 'renderer'))
  mkdirSync(join(root, 'cache', WINDOW), { recursive: true })
  base = await startRendererServer(join(root, 'renderer'))
  serveCacheFrom(join(root, 'cache'))
})
afterAll(() => {
  stopRendererServer()
  serveCacheFrom(null)
  rmSync(root, { recursive: true, force: true })
})

/** How many of this process's descriptors are open on a file of that name. */
function descriptorsOpenOn(name: string): number {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`).endsWith(name)
    } catch {
      return false
    }
  }).length
}

/** A GET that reads one chunk and then hangs up, as a video dropping a segment does. */
function dropAfterFirstChunk(url: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', () => resolve())
    req.end()
  })
}

/** The status of a GET, or 'no answer' when none came within `ms`. */
function statusOf(url: string, ms: number): Promise<number | 'no answer'> {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => resolve('no answer'))
    setTimeout(() => {
      req.destroy()
      resolve('no answer')
    }, ms)
    req.end()
  })
}

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('serving a preview cache window', () => {
  it.runIf(process.platform === 'linux')('lets go of the file when the viewer drops the request mid-transfer', async () => {
    // Far more than a socket's buffers hold, so the server is mid-file when the viewer goes.
    writeFileSync(join(root, 'cache', WINDOW, 's0.ts'), Buffer.alloc(32 * 1024 * 1024, 0x47))

    await dropAfterFirstChunk(`${base}/__cache/${WINDOW}/s0.ts`)
    await until(() => descriptorsOpenOn('s0.ts') === 0, 2_000)

    expect(descriptorsOpenOn('s0.ts')).toBe(0)
  })

  it('answers 404 and stays up when the window is evicted while it is asked for', async () => {
    const file = join(root, 'cache', WINDOW, 's1.ts')
    writeFileSync(file, Buffer.alloc(1024, 0x47))
    evicted.path = file
    // Vitest's own listener would fail the run; collect instead, to assert on.
    const theirs = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const uncaught: unknown[] = []
    const collect = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', collect)
    try {
      const status = await statusOf(`${base}/__cache/${WINDOW}/s1.ts`, 1_000)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(uncaught.map(String)).toEqual([])
      expect(status).toBe(404)
    } finally {
      evicted.path = null
      process.removeListener('uncaughtException', collect)
      for (const listener of theirs) process.on('uncaughtException', listener)
    }
  })

  it('still serves a window that is there', async () => {
    writeFileSync(join(root, 'cache', WINDOW, 'index.m3u8'), '#EXTM3U\n')
    expect(await statusOf(`${base}/__cache/${WINDOW}/index.m3u8`, 1_000)).toBe(200)
    expect(await statusOf(`${base}/__cache/${WINDOW}/missing.ts`, 1_000)).toBe(404)
  })
})
