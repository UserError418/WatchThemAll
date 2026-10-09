/**
 * The engine reader runs inside provider frames the gates never see, so it is
 * run here against fixtures of the three shapes measured in real pages
 * (`filmrelay.ts`): an hls.js in the page's globals (VidSrc), one in React
 * state along the video (VidLux), and whole streams in React state beside it
 * (Videasy). Whether it reaches real cross-origin frames is checked live.
 */

import { describe, expect, it } from 'vitest'
import {
  READ_FRAME_SCRIPT,
  engineAudio,
  engineLengths,
  engineOffer,
  parseFrameReading,
  type FrameReading,
} from './enginereader'

/** What the reader checks to skip DOM nodes while it walks the page's objects. */
class FakeNode {}

class FakeVideo extends FakeNode {
  readonly tagName = 'VIDEO'
  shadowRoot: FakeRoot | null = null
  constructor(
    public duration: number,
    public videoWidth = 1280,
    public videoHeight = 720,
  ) {
    super()
  }
}

class FakeElement extends FakeNode {
  constructor(
    readonly tagName: string,
    public shadowRoot: FakeRoot | null = null,
  ) {
    super()
  }
}

/** A document or a shadow root: everything under it, flat, as `querySelectorAll('*')` gives it. */
class FakeRoot {
  constructor(readonly elements: Array<FakeVideo | FakeElement>) {}
  querySelectorAll(selector: string): Array<FakeVideo | FakeElement> {
    if (selector !== '*') throw new Error(`unexpected selector ${selector}`)
    return this.elements
  }
}

/** Run the probe's script in one fake frame, as `executeJavaScript` would. */
function readIn(window: Record<string, unknown>, document: FakeRoot): unknown {
  return new Function('window', 'document', 'Node', `return ${READ_FRAME_SCRIPT}`)(window, document, FakeNode)
}

function hlsFor(video: FakeVideo, audioTracks?: Array<{ lang: string; name: string }>) {
  return {
    levels: [
      { width: 640, height: 360, bitrate: 800_000 },
      { width: 1920, height: 800, bitrate: 5_000_000 },
    ],
    currentLevel: 0,
    autoLevelEnabled: true,
    media: video,
    ...(audioTracks ? { audioTracks } : {}),
  }
}

describe('the reader in a frame', () => {
  it("finds an engine in the page's globals, with its ladder and its audio tracks", () => {
    const film = new FakeVideo(8_340, 1280, 536)
    const window = {
      __JW: { state: { hls: hlsFor(film, [{ lang: 'en', name: 'English' }, { lang: 'deu', name: 'Deutsch' }]) } },
    }
    const reading = parseFrameReading(readIn(window, new FakeRoot([new FakeElement('DIV'), film])))
    expect(reading).toEqual({
      videos: [
        {
          duration: 8_340,
          width: 1280,
          height: 536,
          levels: [
            { width: 640, height: 360 },
            { width: 1920, height: 800 },
          ],
          streams: false,
          audio: ['en', 'de'],
        },
      ],
    })
  })

  it('finds an engine in React state along the video', () => {
    const film = new FakeVideo(2_885)
    const hook = { memoizedState: { current: hlsFor(film) }, next: null }
    ;(film as unknown as Record<string, unknown>)['__reactFiber$x1'] = { memoizedState: null, return: { memoizedState: hook, return: null } }
    const reading = parseFrameReading(readIn({}, new FakeRoot([film])))
    expect(reading?.videos[0]?.levels).toHaveLength(2)
  })

  it('reads whole streams listed in React state as the levels on offer', () => {
    const film = new FakeVideo(3_619)
    const sources = [
      { quality: '1080p', url: 'https://cdn.example/1080.m3u8' },
      { quality: '720p', url: 'https://cdn.example/720.m3u8' },
    ]
    const root: Record<string, unknown> = { memoizedState: null, return: null }
    const videoFiber: Record<string, unknown> = { memoizedState: null, return: root }
    const hooks = { memoizedState: { sources }, next: { memoizedState: { handleChangeQuality: () => {} }, next: null } }
    root.child = videoFiber
    videoFiber.sibling = { memoizedState: hooks, return: root, child: null, sibling: null }
    ;(film as unknown as Record<string, unknown>)['__reactFiber$x1'] = videoFiber
    const reading = parseFrameReading(readIn({}, new FakeRoot([film])))
    expect(reading?.videos[0]).toMatchObject({ streams: true, levels: [{ width: 0, height: 1080 }, { width: 0, height: 720 }] })
  })

  it('reaches a video inside an open shadow root', () => {
    const film = new FakeVideo(1_320)
    const host = new FakeElement('MEDIA-PLAYER', new FakeRoot([film]))
    const reading = parseFrameReading(readIn({}, new FakeRoot([host])))
    expect(reading?.videos.map((v) => v.duration)).toEqual([1_320])
  })

  it('skips a video with no length yet, and still reports one with no engine', () => {
    const reading = parseFrameReading(readIn({}, new FakeRoot([new FakeVideo(Number.NaN), new FakeVideo(30)])))
    expect(reading?.videos).toEqual([{ duration: 30, width: 1280, height: 720, levels: [], streams: false, audio: [] }])
  })

  it('only looks: the page, its video and its engine are as they were', () => {
    const film = new FakeVideo(2_885)
    const engine = hlsFor(film)
    const window: Record<string, unknown> = { hls: engine }
    const before = { window: Object.keys(window), film: Object.keys(film), engine: JSON.stringify({ ...engine, media: null }) }
    readIn(window, new FakeRoot([film]))
    readIn(window, new FakeRoot([film]))
    expect(Object.keys(window)).toEqual(before.window)
    expect(Object.keys(film)).toEqual(before.film)
    expect(JSON.stringify({ ...engine, media: null })).toBe(before.engine)
  })

  it('ignores an engine attached to another video', () => {
    const film = new FakeVideo(2_885)
    const reading = parseFrameReading(readIn({ hls: hlsFor(new FakeVideo(30)) }, new FakeRoot([film])))
    expect(reading?.videos[0]?.levels).toEqual([])
  })
})

describe('parseFrameReading', () => {
  it('turns away what is not a reading, and what a page made of one', () => {
    expect(parseFrameReading(null)).toBeNull()
    expect(parseFrameReading({ videos: 'no' })).toBeNull()
    expect(
      parseFrameReading({
        videos: [
          { duration: 'x' },
          { duration: 0 },
          null,
          { duration: 100, levels: [{ height: -1 }, { height: 720, width: 'wide' }], audio: [{ language: 'und' }], streams: 'yes' },
        ],
      }),
    ).toEqual({ videos: [{ duration: 100, width: 0, height: 0, levels: [{ width: 0, height: 720 }], streams: false, audio: [] }] })
  })
})

describe('what the frames say about the source', () => {
  const frame = (...videos: Array<Partial<FrameReading['videos'][number]> & { duration: number }>): FrameReading => ({
    videos: videos.map((v) => ({ width: 0, height: 0, levels: [], streams: false, audio: [], ...v })),
  })

  it("offers the top of the title's ladder, named as the source lists name it", () => {
    const readings = [frame({ duration: 8_340, levels: [{ width: 1280, height: 536 }, { width: 1920, height: 800 }] })]
    expect(engineOffer(readings, 139)).toBe(1080)
  })

  it("does not take an advert's ladder for the source's", () => {
    const readings = [
      frame({ duration: 30, levels: [{ width: 3840, height: 2160 }], audio: ['fr'] }),
      frame({ duration: 8_340, levels: [{ width: 1280, height: 720 }], audio: ['en'] }),
    ]
    expect(engineOffer(readings, 139)).toBe(720)
    expect(engineAudio(readings, 139)).toEqual(['en'])
  })

  it('offers nothing when no engine listed sizes: a picture alone is only a floor', () => {
    expect(engineOffer([frame({ duration: 8_340, width: 1920, height: 800 })], 139)).toBeNull()
    expect(engineOffer([], null)).toBeNull()
  })

  it('reports every length it saw, for the right-film check', () => {
    expect(engineLengths([frame({ duration: 30 }), frame({ duration: 272 }, { duration: 8_340 })])).toEqual([30, 272, 8_340])
  })
})
