import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import { FakeSession } from './playerview.fixture'
import { observeErrors, observeSendHeaders } from './webrequesthub'

/** The fake keeps one listener per event, as Electron does; that is what is under test. */
const asSession = (fake: FakeSession): Session => fake as unknown as Session

describe('observing a session through the hub', () => {
  it('hands each request to every observer, where Electron keeps only the last listener', () => {
    const session = new FakeSession()
    const seen: string[] = []
    observeSendHeaders(asSession(session), (details) => void seen.push(`player ${details.url}`))
    observeSendHeaders(asSession(session), (details) => void seen.push(`casting ${details.url}`))

    session.webRequest.emit('sendHeaders', { url: 'https://a.example/api' })

    expect(seen).toEqual(['player https://a.example/api', 'casting https://a.example/api'])
  })

  it('keeps the others when one observer stops, and lets go of the session with the last', () => {
    const session = new FakeSession()
    const seen: string[] = []
    const stopPlayer = observeSendHeaders(asSession(session), () => void seen.push('player'))
    const stopCasting = observeSendHeaders(asSession(session), () => void seen.push('casting'))

    stopPlayer()
    session.webRequest.emit('sendHeaders', { url: 'https://a.example/1' })
    expect(seen).toEqual(['casting'])
    expect(session.webRequest.listening('sendHeaders')).toBe(true)

    stopCasting()
    expect(session.webRequest.listening('sendHeaders')).toBe(false)
  })

  it('keeps events and sessions apart', () => {
    const one = new FakeSession()
    const other = new FakeSession()
    const seen: string[] = []
    observeSendHeaders(asSession(one), () => void seen.push('sent on one'))
    observeErrors(asSession(one), () => void seen.push('failed on one'))
    observeSendHeaders(asSession(other), () => void seen.push('sent on other'))

    one.webRequest.emit('errorOccurred', { url: 'https://a.example/2' })
    other.webRequest.emit('sendHeaders', { url: 'https://a.example/3' })

    expect(seen).toEqual(['failed on one', 'sent on other'])
  })
})
