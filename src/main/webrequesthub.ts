/**
 * Watching a session's requests, for more than one watcher at a time.
 *
 * Electron keeps **one** listener per `webRequest` event per session: a second
 * `onSendHeaders` on the same session silently replaces the first, with no
 * error and no warning (measured on Electron 42.5.0: two listeners, a page of
 * four requests, and the first listener was called zero times).
 *
 * That bit the player. `playerview.ts` counted the requests a page had sent
 * and not yet had answered, so that a page still waiting on its backend at
 * the silence deadline reads as loading rather than idle (`judgeSilence`).
 * Casting then attached its own `onSendHeaders` to the same session
 * (`castcapture.ts`), the player's count never went above zero again, and a
 * page stuck on "Fetching Prism" got no offer to switch source at all.
 *
 * So the events that only *observe* a request go through here: each session
 * gets one Electron listener per event, which hands every request to all of
 * that session's observers. The events that *decide* a request's fate
 * (`onBeforeRequest`, `onBeforeSendHeaders`, `onHeadersReceived`) are not
 * here on purpose: a request can only have one answer, and each of those has
 * exactly one owner per session (`providerguard.ts`, `identity.ts`).
 *
 * `eslint.config.js` bans the observing events outside this file.
 */

import type { Session } from 'electron'

type Observer<Details> = (details: Details) => void

/** Every request an observer could care about: the pages here are all on the web. */
const WEB = { urls: ['http://*/*', 'https://*/*'] }

/** Each session's observers, by event. Weak, so a closed player's session is not kept alive by its list. */
const observersBySession = new WeakMap<Session, Map<string, Set<Observer<never>>>>()

/**
 * Add `observer` to `event`'s list for `session`, registering the one Electron
 * listener when the list is new and removing it when the list is empty again.
 * `register` is the typed Electron call for the event, given the fan-out
 * listener, or null to unsubscribe.
 */
function observe<Details>(
  session: Session,
  event: string,
  observer: Observer<Details>,
  register: (listener: Observer<Details> | null) => void,
): () => void {
  let byEvent = observersBySession.get(session)
  if (byEvent === undefined) {
    byEvent = new Map()
    observersBySession.set(session, byEvent)
  }
  let observers = byEvent.get(event) as Set<Observer<Details>> | undefined
  if (observers === undefined) {
    const fresh = new Set<Observer<Details>>()
    observers = fresh
    byEvent.set(event, fresh as Set<Observer<never>>)
    register((details) => {
      // A copy, so an observer that unsubscribes itself mid-request does not
      // make the loop skip the next one.
      for (const each of [...fresh]) each(details)
    })
  }
  observers.add(observer)

  const list = observers
  const events = byEvent
  return () => {
    if (!list.delete(observer) || list.size > 0) return
    events.delete(event)
    register(null)
  }
}

/** Each request just before it goes out, with the headers actually sent (`Cookie` included). */
export function observeSendHeaders(
  session: Session,
  observer: Observer<Electron.OnSendHeadersListenerDetails>,
): () => void {
  return observe(session, 'sendHeaders', observer, (listener) =>
    // eslint-disable-next-line no-restricted-syntax -- the one registration this module exists to own
    session.webRequest.onSendHeaders(WEB, listener),
  )
}

/** Each request that completed, whatever its status. */
export function observeCompleted(
  session: Session,
  observer: Observer<Electron.OnCompletedListenerDetails>,
): () => void {
  return observe(session, 'completed', observer, (listener) =>
    // eslint-disable-next-line no-restricted-syntax -- the one registration this module exists to own
    session.webRequest.onCompleted(WEB, listener),
  )
}

/** Each request that failed without an answer: cancelled, refused, unreachable. */
export function observeErrors(
  session: Session,
  observer: Observer<Electron.OnErrorOccurredListenerDetails>,
): () => void {
  return observe(session, 'errorOccurred', observer, (listener) =>
    // eslint-disable-next-line no-restricted-syntax -- the one registration this module exists to own
    session.webRequest.onErrorOccurred(WEB, listener),
  )
}
