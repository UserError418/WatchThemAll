/**
 * The scan runner's sequencing: what one scan may do to another.
 *
 * The probes themselves need a device. What matters here is the order of the
 * side effects around them — closing every probe session and resuming
 * playback — because the runner's cleanup does both wholesale, and a second
 * scan started under it used to lose its probes and its paused player.
 */

import { beforeEach, expect, it, vi } from 'vitest'
import type { Provider } from '@shared/types'

const events: string[] = []
/** Released by the test, to hold a run inside its cleanup. */
let releaseClose: () => void = () => {}

vi.mock('./probeview', () => ({
  openProbe: vi.fn(),
  closeAllProbes: vi.fn(
    () =>
      new Promise<number>((resolve) => {
        events.push('closeAll')
        releaseClose = () => resolve(0)
      }),
  ),
}))
vi.mock('./cast', () => ({ capture: vi.fn(), PEEK_LIMIT_BYTES: 16 * 1024 }))

const { createScanRunner } = await import('./scan')

/** No template for films, so it settles at once as unsupported, with no probe. */
const provider = { id: 'a', name: 'A', rootUrl: 'https://a.example/', tv: { urlTemplate: '{imdb}' } } as unknown as Provider
const film = { imdbId: 'tt1', tmdbId: 1, type: 'movie' as const, season: null, episode: null, runtimeMinutes: null }

beforeEach(() => {
  events.length = 0
})

function freshRunner() {
  return createScanRunner({
    providers: () => [provider],
    suspendPlayback: () => events.push('suspend'),
    resumePlayback: () => events.push('resume'),
    onProgress: () => {},
  })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A runner past its start-up clean-up, so a test sees only its own scans. */
async function runner() {
  const scans = freshRunner()
  releaseClose()
  await tick()
  events.length = 0
  return scans
}

it('closes the probe sessions a previous page left running, before its first scan', async () => {
  const scans = freshRunner()
  expect(events).toEqual(['closeAll'])

  // The first scan waits for it: closing every session mid-scan is what
  // turned a scan's own probes into a row of reds.
  const first = scans.run('movie:1', film)
  await tick()
  expect(events).toEqual(['closeAll'])

  releaseClose()
  await tick()
  expect(events).toEqual(['closeAll', 'suspend', 'closeAll'])
  releaseClose()
  await first
})

it('starts a new scan only after the one it replaced has cleaned up', async () => {
  const scans = await runner()

  const first = scans.run('movie:1', film)
  await tick()
  expect(events).toEqual(['suspend', 'closeAll'])

  // Started while the first is still closing its sessions.
  const second = scans.run('movie:1', film)
  await tick()
  expect(events).toEqual(['suspend', 'closeAll'])

  releaseClose()
  await first
  await tick()
  expect(events).toEqual(['suspend', 'closeAll', 'resume', 'suspend', 'closeAll'])

  releaseClose()
  await second
  expect(events.at(-1)).toBe('resume')
})

it('measures nothing for a scan cancelled before it began', async () => {
  const scans = await runner()
  const first = scans.run('movie:1', film)
  await tick()
  const second = scans.run('movie:1', film)
  scans.cancel()

  releaseClose()
  await first
  expect(await second).toMatchObject({ verdicts: {} })
  expect(events.filter((event) => event === 'suspend')).toHaveLength(1)
})
