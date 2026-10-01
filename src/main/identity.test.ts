import { describe, expect, it, vi } from 'vitest'
import { CHROME_UA, presentAsChrome, reducedChromeUA } from './identity'

describe('presentAsChrome', () => {
  it("replaces the renderer's Electron User-Agent on a script's own request", () => {
    // What a provider page's fetch() carried before: the document said Chrome,
    // this said Electron, and Videm answered every such call with 403.
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) watchthemall/2.0.9 Chrome/148.0.7778.271 Electron/42.5.0',
      Accept: '*/*',
    }
    presentAsChrome(headers)
    expect(headers['User-Agent']).toBe(CHROME_UA)
    expect(headers.Accept).toBe('*/*')
  })

  it('leaves exactly one User-Agent, whatever case it arrived in', () => {
    const headers: Record<string, string> = { 'user-agent': 'Electron/42.5.0' }
    presentAsChrome(headers)
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'user-agent')).toEqual(['User-Agent'])
  })

  it("leaves the client hints to Chromium, which derives them from what the page's JavaScript sees", () => {
    const native = '"Not/A)Brand";v="99", "Chromium";v="148"'
    const headers: Record<string, string> = { 'Sec-CH-UA': native, 'Sec-CH-UA-Platform': '"Linux"' }
    presentAsChrome(headers)
    expect(headers['Sec-CH-UA']).toBe(native)
    expect(headers['Sec-CH-UA-Platform']).toBe('"Linux"')
  })
})

describe('reducedChromeUA', () => {
  it("is Chrome's reduced User-Agent: the major version only, and the platform's frozen string", () => {
    expect(reducedChromeUA('148.0.7778.271', 'linux')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    )
    expect(reducedChromeUA('148.0.7778.271', 'win32')).toContain('(Windows NT 10.0; Win64; x64)')
    expect(reducedChromeUA('148.0.7778.271', 'darwin')).toContain('(Macintosh; Intel Mac OS X 10_15_7)')
  })

  it('never names the app or Electron', () => {
    expect(CHROME_UA).not.toMatch(/electron|watchthemall/i)
  })
})

describe('on the phone', () => {
  it('loads where there is no `process`, as in a WebView', async () => {
    // tmdb.ts carries this module into the phone's bundle; read unguarded,
    // `process` stopped the phone app at startup with an empty screen.
    vi.resetModules()
    const saved = globalThis.process
    const { CHROME_UA: tmdbIdentity } = await (async () => {
      Reflect.deleteProperty(globalThis, 'process')
      try {
        return await import('./identity')
      } finally {
        globalThis.process = saved
      }
    })()
    expect(tmdbIdentity).toMatch(/Chrome\/\d+\.0\.0\.0/)
  })
})
