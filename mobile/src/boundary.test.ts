/**
 * What the phone's bundle reaches runs without Node and without Electron.
 *
 * Two checks over the same set of files, which `tools/phonereach.js` works
 * out from the imports (ESLint puts its boundary rules on the same set):
 *
 * - no package the bundle imports at run time is Node's or Electron's. ESLint
 *   says the same line by line; this is the check that follows the graph
 *   exactly as the build does, and fails if the walker itself stops finding
 *   anything.
 * - every module of the business layer in it loads with no `process` at
 *   all, as in a WebView. 2.0.11 caught `identity.ts` reading
 *   `process.versions` unguarded only on the emulator, as a blank screen
 *   at startup; `identity.test.ts` pinned that one module, and this covers
 *   every module the phone reaches.
 */

import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { phoneReach } from '../../tools/phonereach.js'

const ROOT = resolve(__dirname, '../..')
const reach = phoneReach(ROOT)

/** The business layer's share of the bundle: what the bridge takes from the desktop. */
const BUSINESS = reach.files.filter((file) => /^src\/(main|shared)\/.*\.ts$/.test(file))

const NODE = new Set(builtinModules)
const notPortable = (name: string): boolean =>
  name === 'electron' || name.startsWith('electron/') || name.startsWith('node:') || NODE.has(name)

describe('the phone bundle', () => {
  it('reaches the business layer through the bridge', () => {
    // If the walker stopped following imports, every check here and the
    // ESLint rules on the same set would pass on nothing.
    expect(reach.files).toContain('mobile/src/bridge/index.ts')
    expect(reach.files).toContain('src/main/tmdb.ts')
    expect(reach.files).toContain('src/main/identity.ts')
    expect(reach.files).toContain('src/shared/sourceresults.ts')
    expect(BUSINESS.length).toBeGreaterThan(50)
  })

  it('imports no Node or Electron module at run time', () => {
    const offenders = [...reach.packages].filter(([name]) => notPortable(name))
    expect(offenders).toEqual([])
  })

  it('would be caught reaching one that does', () => {
    // The known case: the desktop's scan service drives Electron windows,
    // which is why the phone has its own (`bridge/scan.ts`) and why
    // `progressIsAbout` moved out of it into `src/shared/scanprogress.ts`.
    const desktopScan = phoneReach(ROOT, ['src/main/scanservice.ts'])
    expect([...desktopScan.packages.keys()].filter(notPortable)).toContain('electron')
  })

  it('loads every module of the business layer where there is no `process`', async () => {
    vi.resetModules()
    // Vitest's own messaging leaves a `process.nextTick` callback behind that
    // reads `process`; let it run before taking `process` away. While it is
    // gone, Vitest leaves the callback out.
    await new Promise((done) => setTimeout(done, 0))
    const saved = globalThis.process
    const failed: string[] = []
    Reflect.deleteProperty(globalThis, 'process')
    try {
      for (const file of BUSINESS) {
        try {
          await import(resolve(ROOT, file))
        } catch (error) {
          failed.push(`${file}: ${String(error)}`)
        }
      }
    } finally {
      globalThis.process = saved
    }
    expect(failed).toEqual([])
  })
})
