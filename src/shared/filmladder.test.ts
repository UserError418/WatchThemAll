import { describe, expect, it } from 'vitest'
import { fakeNetwork, mediaPlaylist } from './downloads/downloads.fixture'
import { findLadder, ladderAfterVerdict, ladderOffer, withLadderOffer } from './filmladder'

const H = { Referer: 'https://source.example/' }

/** A 139-minute film's master: a ladder to 1080p, sound in English and German. */
const filmMaster = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="en",NAME="English",URI="en.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="de",NAME="Deutsch",URI="de.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x536,AUDIO="a"',
  '720.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x800,AUDIO="a"',
  '1080.m3u8',
].join('\n')
const film = mediaPlaylist('https://cdn/film', 834, 10) // 139 minutes
const clip = mediaPlaylist('https://cdn/clip', 17, 10) // under 3 minutes
const advertMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160\nad.m3u8\n'

describe('findLadder', () => {
  it("finds the film's master by its variant's length, past an advert's", async () => {
    const net = fakeNetwork({
      'https://ads/master.m3u8': { status: 200, body: advertMaster },
      'https://ads/ad.m3u8': { status: 200, body: clip },
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/720.m3u8': { status: 200, body: film },
    })
    const found = await findLadder(
      [
        { url: 'https://ads/master.m3u8', headers: H },
        { url: 'https://cdn/master.m3u8', headers: H },
      ],
      net,
      139,
    )
    expect(found.ladder?.url).toBe('https://cdn/master.m3u8')
    expect(found.ladder?.headers).toEqual(H)
    // The first variant listed is the one checked: every variant is the same film.
    expect(found.ladder?.chosen.url).toBe('https://cdn/720.m3u8')
    expect(Math.round(found.ladder?.seconds ?? 0)).toBe(8_340)
    // The 4K of the advert's master is not the source's.
    expect(found.ladder && ladderOffer(found.ladder)).toEqual({ quality: 1080, audio: ['en', 'de'] })
  })

  it('finds no ladder in a clip served in the film\'s place, and says why', async () => {
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/720.m3u8': { status: 200, body: clip },
    })
    const found = await findLadder([{ url: 'https://cdn/master.m3u8', headers: H }], net, 139)
    expect(found.ladder).toBeNull()
    expect(found.refused).toEqual({ kind: 'wrong-length', seconds: 170 })
  })

  it('without a runtime, still refuses anything shorter than any episode', async () => {
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/720.m3u8': { status: 200, body: clip },
    })
    expect((await findLadder([{ url: 'https://cdn/master.m3u8', headers: H }], net, null)).ladder).toBeNull()
  })

  it('reads a ladder whose variants a download could not fetch: the browser plays them', async () => {
    const ranged = film.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-BYTERANGE:1000@0')
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/720.m3u8': { status: 200, body: ranged },
    })
    const found = await findLadder([{ url: 'https://cdn/master.m3u8', headers: H }], net, 139)
    expect(found.ladder && ladderOffer(found.ladder).quality).toBe(1080)
  })

  it('keeps the renditions fetched without a master, for a download to fall back on', async () => {
    const net = fakeNetwork({
      'https://cdn/api': { status: 200, body: '{"ok":true}' },
      'https://cdn/film.m3u8': { status: 200, body: film },
    })
    const found = await findLadder(
      [
        { url: 'https://cdn/api', headers: H },
        { url: 'https://cdn/film.m3u8', headers: H },
      ],
      net,
      139,
    )
    expect(found.ladder).toBeNull()
    expect(found.renditions.map((r) => r.url)).toEqual(['https://cdn/film.m3u8'])
  })

  it("lets the caller choose the variant and refuse a master in its own words", async () => {
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/1080.m3u8': { status: 200, body: film },
    })
    const requests = [{ url: 'https://cdn/master.m3u8', headers: H }]
    const chosen = await findLadder(requests, net, 139, { choose: (variants) => variants.at(-1) ?? null })
    expect(chosen.ladder?.chosen.url).toBe('https://cdn/1080.m3u8')
    const refused = await findLadder(requests, net, 139, { refuseMaster: () => ({ kind: 'caller', reason: 'not for us' }) })
    expect(refused).toMatchObject({ ladder: null, refused: { kind: 'caller', reason: 'not for us' } })
  })

  it('asks for each captured address once, and no more than thirty of them', async () => {
    const routes: Record<string, { status: number; body: string }> = {}
    const requests = Array.from({ length: 40 }, (_, i) => ({ url: `https://cdn/api/${i}`, headers: H }))
    for (const request of requests) routes[request.url] = { status: 200, body: '{}' }
    const net = fakeNetwork(routes)
    await findLadder([...requests, requests[0]!], net, 139)
    expect([...net.counts.values()].reduce((a, b) => a + b, 0)).toBe(30)
  })
})

describe('ladderOffer', () => {
  it('offers nothing when the master names no sizes', async () => {
    const bare = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nlow.m3u8\n'
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: bare },
      'https://cdn/low.m3u8': { status: 200, body: film },
    })
    const found = await findLadder([{ url: 'https://cdn/master.m3u8', headers: H }], net, 139)
    expect(found.ladder && ladderOffer(found.ladder)).toEqual({ quality: null, audio: [] })
  })
})

describe('what the ladder adds to a test', () => {
  const stream = { verdict: 'stream', quality: 720, qualityKind: 'floor' as const, audio: null }

  it("takes the ladder's offer over a floor at or below it, with its audio", () => {
    expect(withLadderOffer(stream, { quality: 1080, audio: ['en'] })).toEqual({ ...stream, quality: 1080, qualityKind: 'offered', audio: ['en'] })
    expect(withLadderOffer(stream, { quality: 720, audio: [] })).toMatchObject({ quality: 720, qualityKind: 'offered' })
  })

  it('never lowers what was seen, nor replaces an offer or a known audio list', () => {
    // A floor above the ladder's top says the ladder read is not the whole story.
    expect(withLadderOffer({ ...stream, quality: 1080 }, { quality: 720, audio: [] })).toBeNull()
    expect(withLadderOffer({ ...stream, qualityKind: 'offered' as const }, { quality: 2160, audio: [] })).toBeNull()
    expect(withLadderOffer({ ...stream, audio: ['de'] }, { quality: null, audio: ['en'] })).toBeNull()
  })

  it('is looked for only after a stream whose test read no offer', async () => {
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: filmMaster },
      'https://cdn/720.m3u8': { status: 200, body: film },
    })
    const requests = [{ url: 'https://cdn/master.m3u8', headers: H }]
    expect(await ladderAfterVerdict(stream, requests, net, 139)).toMatchObject({ quality: 1080, qualityKind: 'offered', audio: ['en', 'de'] })
    const total = (): number => [...net.counts.values()].reduce((a, b) => a + b, 0)
    const asked = total()
    expect(await ladderAfterVerdict({ ...stream, qualityKind: 'offered' as const }, requests, net, 139)).toBeNull()
    expect(await ladderAfterVerdict({ ...stream, verdict: 'unsure' }, requests, net, 139)).toBeNull()
    expect(total()).toBe(asked)
  })
})
