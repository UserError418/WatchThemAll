import { describe, expect, it } from 'vitest'
import { CHROME_UA, presentAsChrome } from './identity'

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

  it('claims the same Chrome in the client hints as in the User-Agent', () => {
    const headers: Record<string, string> = { 'Sec-CH-UA-Full-Version-List': '"Electron";v="42.5.0"' }
    presentAsChrome(headers)
    const major = /Chrome\/(\d+)\./.exec(headers['User-Agent']!)![1]
    expect(headers['Sec-CH-UA']).toContain(`"Google Chrome";v="${major}"`)
    expect(headers['Sec-CH-UA-Full-Version-List']).toBeUndefined()
  })
})
