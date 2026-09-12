# Android backlog

What the desktop app can do and the phone app cannot, and why.

Kept because the two apps ship from one repo and it is otherwise easy to lose
track of which half a feature landed in. **Every desktop feature gets an entry
here unless it is shared code** — and a surprising amount is, so the first
section is the one to read before assuming a port is needed.

## What is already shared, and needs no port

The renderer, the design system, the types and most of the business layer are
one codebase. A change to any of these is live on both apps the moment it
builds:

| | |
|---|---|
| `src/renderer/**` | Every view, component and stylesheet. |
| `src/shared/**` | Domain types, the IPC contract, and the store. |
| `src/main/tmdb.ts`, `imdb.ts`, `search.ts` | Plain `fetch`. |
| `src/main/providers.ts`, `outcomes.ts` | Pure functions. |
| `src/main/migrate.ts`, `sync.ts`, `taste.ts`, `releases.ts` | Pure over the document. |
| `src/main/malimport.ts`, `malapply.ts` | Parser is `DOMParser`-free. |

The platform boundary is a single interface — `WtaApi` in `src/shared/ipc.ts`.
Eighteen renderer files call `window.wta` and none of them touch anything else,
which is what made the phone app a port rather than a rewrite. Anything written
against that interface is automatically shared; anything written *below* it, in
`src/main/playerview.ts` or `windows.ts`, is not.

**The store is shared as of the collection-API rewrite.** `src/shared/store`
holds the document shape, the migration, the coalescing and the mutators; each
app supplies four methods about bytes. So a change to how anything is persisted
needs no entry here.

---

## Open items

### The inline player's position tracking
**Blocked by the platform, not by effort.**

On desktop the video is a native `WebContentsView` and the main process reads
the provider's `<video>` through `WebFrameMain.executeJavaScript`, which runs in
any frame regardless of origin. That is a privilege of an Electron embedder.
Android's WebView has no equivalent, and neither does the sandboxed iframe the
phone plays in.

Everything downstream is therefore absent on Android:

- **Resume to an exact position**, including carrying it across a provider
  switch.
- **Watched detection.** `isWatchedEnough` is pure and would run fine on the
  phone; it has nothing to feed it. The phone cannot currently mark anything
  watched automatically — only by hand.
- **Stall detection and the auto-switch countdown.**

Worth knowing: because the renderer is shared, the **episode progress bar built
for the desktop already renders on Android** — it just never has a position to
draw, so it is always absent. Nothing to port; the gap is upstream of it.

*Possible route:* a Kotlin `WebViewClient` that injects a script into the
provider's document. Android's `evaluateJavascript` runs in the main frame only,
so a provider that nests its player one iframe deep — most of them — would still
be out of reach. Not obviously solvable.

### Notifications on a schedule the user controls
The Settings screen has a release-check interval. On Android the sweep runs on
resume (throttled to an hour) and the alarms are scheduled from known air dates,
so the setting is inert there. Either wire it to the alarm scheduling or hide it
on the phone.

### The chrome bar's auto-hide
Desktop-only, and only because the phone has no pointer to hide from. The rule
there — the bar retreats on a timer, held open by a pending suggestion or by the
pointer resting on it — has no phone equivalent; a touch UI wants tap-to-toggle
instead, which the phone already does.

Worth knowing if that ever changes: the desktop's hardest part is that neither
renderer can see the pointer over the video, so main forwards it from the
view's raw input stream (`src/main/pointerzone.ts`). Android's WebView has no
equivalent hook, so the same approach would not port even if it were wanted.

### The remote provider catalogue
The desktop refreshes the catalogue in the background and caches it to disk. The
phone ships whatever catalogue its APK was built with. A staleness problem
rather than a correctness one, and the custom-provider form covers the urgent
case.

### Data export to a file the user picks
Desktop opens a save dialog. The phone shares the file out through the system
share sheet instead, which is the platform-appropriate answer but not the same
thing — there is no "save to this folder" without the Storage Access Framework.

### The menu bar and keyboard shortcuts
Episode stepping with the arrow keys, `R` to reload. No keyboard on a phone; the
chrome bar's own controls are the substitute. Not a gap worth closing.

### Where the refresh token is kept
**The one real gap left by sync**, and it is narrow.

The desktop puts the Google refresh token in the OS credential store through
Electron's `safeStorage` — Keychain, libsecret, DPAPI. The phone puts it in
Capacitor `Preferences`, which is `SharedPreferences` in the app's private data
directory. That is readable by this app and by root, and it is **not** the
Android keystore; reaching the keystore needs a native Kotlin module, and this
project has none.

Worth keeping in proportion: the library file itself sits behind exactly the
same boundary, so the token is no less protected than the data it unlocks. On an
unrooted device the private data directory *is* the boundary. Closing this means
adding a native module, which is a real cost against a modest gain.

*Everything else about sync is shared and needs no port.* The device flow, the
Drive backend, the merge and the coalescing are `@shared/sync` and
`@shared/store`, identical on both. That is the payoff of a flow with no
redirect: no WebView for Google to refuse, no Play-services plugin, and no APK
signing fingerprint registered anywhere — so a forked or self-built APK signs in
exactly as the released one does.

---

## Closed

- **Ad blocking.** Fixed by playing in a sandboxed iframe rather than a Custom
  Tab; the `sandbox` attribute denies popups the way `setWindowOpenHandler`
  does on desktop.
- **The launcher icon.** Nothing to port — the phone's icons were drawn in the
  app's amber from the start, and the desktop's had been left as a blue triangle
  from before the interface was redesigned. Both now render from the same mark,
  which is also the one the app draws next to its own wordmark.
- **Playing inside an iframe.** Nothing to port — the phone got here first, and
  the desktop has now followed it. Videasy began answering 403 to any request
  whose `Sec-Fetch-Dest` was `document`, which is what a top-level navigation
  sends and what the desktop player used to do; the phone was unaffected because
  an iframe sends `Sec-Fetch-Dest: iframe`. The desktop now loads providers
  inside a local shell page for the same reason, so both apps present themselves
  to a provider the same way.
- **In-player provider switching**, episode stepping, reload. Real since the
  iframe player.
- **A store that can survive a merge.** Shared.
