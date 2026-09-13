# WatchThemAll for Android

The same app, on a phone. Not a rewrite and not a second codebase — the Svelte
renderer, the design system and the whole business layer are the desktop ones,
built by a second Vite config and wrapped in a Capacitor WebView.

```bash
npm run build:mobile     # web bundle -> out/mobile
npm run sync:mobile      # copy it into the Gradle project
npm run apk              # both of the above, then assembleDebug
```

The APK lands at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Building needs JDK 21 and the Android SDK; `scripts/provision-android.sh`
installs both and explains why the system JDK will not do.

## Why this is a port and not a rewrite

The renderer's entire contact with the platform is one interface — `WtaApi` in
`src/shared/ipc.ts`, 26 methods and ten event subscriptions. Eighteen renderer
files call `window.wta` and none of them touch anything else. So the phone app
needs exactly one new thing: a second implementation of that interface.

That is `mobile/src/bridge/`. Everything else is shared:

| Layer | Shared? | Notes |
|---|---|---|
| `src/renderer/**` | verbatim | Every view, component and style. |
| `src/shared/**` | verbatim | Types and the IPC contract. |
| `src/main/tmdb.ts`, `imdb.ts`, `search.ts` | verbatim | Plain `fetch`. |
| `src/main/providers.ts`, `outcomes.ts` | verbatim | Pure functions. |
| `src/main/migrate.ts`, `sync.ts` | verbatim | Same document, same export format. |
| `src/main/malimport.ts`, `malapply.ts` | verbatim | Parser is `DOMParser`-free. |
| `src/main/taste.ts`, `releases.ts` | verbatim | `releases` takes a structural store. |
| `src/main/catalog.ts` | verbatim | Storage behind a port; see below. |
| `src/main/store.ts` | replaced | Node `fs` -> `mobile/src/bridge/store.ts`. |
| `src/main/playerview.ts`, `windows.ts` | not ported | Replaced by `bridge/playersurface.ts`. |

This held because the business layer never imported Electron or Node in the
first place. That was not luck — it is what the architecture contract in
`pyproject.toml`'s sibling, `lint-imports`, has been enforcing on the desktop
app since cycle 2. The phone build is the first time it paid for itself.

## Two things that make it work

**`CapacitorHttp` is enabled.** The WebView serves the app from
`https://localhost`, so every TMDB and IMDB call is cross-origin. TMDB sends
permissive CORS headers; IMDB's suggestion endpoint does not, and federated
search is the only path that reaches the IMDB ids providers key on. Routing
`fetch` through the native HTTP stack removes the browser's same-origin check
from the question entirely, and is why `tmdb.ts` and `imdb.ts` needed no edits.

**The phone layout is almost entirely token retuning.** Svelte scopes component
styles with a hash class, so a plain `.grid` rule in a global sheet loses to
`.grid.svelte-abc123`. Winning that fight across forty rules means `!important`
on most of them or forking the components, and a forked component is a second
place every future change has to land. Custom properties do not have that
problem: they cascade normally and the components already read them for every
dimension that matters. So `mobile/src/styles/mobile.css` is mostly twenty
token values, and only the genuinely structural changes — the bottom tab bar,
full-bleed sheets — use a real selector.

## The player, and why it is an iframe

Playback runs **inside the app**, in an iframe that the bridge positions
wherever the renderer's own player chrome says the video goes. The desktop
shape is unchanged: the platform layer owns a video surface, the renderer owns
the chrome over it. Only the surface differs — a `WebContentsView` there, an
`<iframe>` here.

The first version handed playback to a Chrome Custom Tab, and the ads were the
reason that had to change. Every provider in the catalogue monetises with
popunders, and the desktop's entire defence is one line —
`setWindowOpenHandler(() => ({ action: 'deny' }))`. A Custom Tab is a real
browser tab: the app controls nothing inside it, so the phone showed ads the
desktop never does.

### Where the ad blocking lives, and why it moved

It was the iframe's `sandbox` attribute, which blocks `window.open` by omitting
`allow-popups`. **That attribute is why several providers would not play at
all.** They test for it and refuse to serve: VidFast replaces its entire page
with the words "Please Disable Sandbox". Measured both ways on an Android 16
emulator — the refusal with the attribute, its real player without it, same URL
and same WebView seconds apart.

So the same two guarantees now come from two native settings, neither of which
a page can detect:

- `setJavaScriptCanOpenWindowsAutomatically(false)` in `MainActivity` makes
  `window.open` return `null` in every frame. Verified in the running app.
- `PlayerNavigationClient` refuses any main-frame navigation to a third party,
  and allows navigations *within* the player frame. Without it, Capacitor's own
  `shouldOverrideUrlLoading` fires an `ACTION_VIEW` intent for an ad redirect
  and the user lands in Chrome — measured, one tap on VidRock's play button.

Both together are the desktop's behaviour: an ad can replace the picture inside
the player, and it can do nothing to the app around it. The APK is still a pure
web bundle plus two dozen lines of Java that only configure the WebView.

Every provider URL is an *embed* endpoint — being framed is the product — and
the headers agree: across the eight core providers none sends a restrictive
`X-Frame-Options` or `frame-ancestors`, and two allow framing explicitly.

## Progress, without reading the video

The desktop learns where a video is by reading `currentTime` off the provider's
own `<video>`, which `WebFrameMain.executeJavaScript` allows in any frame
regardless of origin. Neither a WebView nor an iframe grants anything like it,
and this file said for three versions that progress tracking was therefore
impossible here.

That was true of the approach and not of the problem. **Several providers post
their position out to whatever is framing them**, and nobody had looked.
Measured on an emulator, listening on the app's own window:

| Provider | Posts | Carries |
|---|---|---|
| VidFast | `PLAYER_EVENT`, `MEDIA_DATA` | position, duration, season, episode, tmdb id |
| Videasy | `PLAYER_EVENT` | position, duration, season, episode, tmdb id |
| VidLux, VidFlix, VidRock | nothing | — |

`src/main/playermessage.ts` is the parser — pure, in the business layer, and
tested against the transcribed payloads. Two things about it are load-bearing:

- **The sender is checked, not the origin.** `event.source ===
  frame.contentWindow` is a window-identity comparison that works cross-origin
  and cannot be forged by another frame. An origin allowlist would reject
  working players, because providers redirect through their own CDNs.
- **Every reading names its title, and the bridge checks it.** VidFast's
  `MEDIA_DATA` is its *entire* progress library, and picking an entry out of it
  means guessing which one is on screen. The guess is right once something has
  played and wrong for the first message of every session, where the freshest
  entry belongs to whatever ran last time.

Thresholds are the desktop's, imported from `@main/resume` rather than restated
— including the three-way `resumeAction`, which matters far more here than
there: a provider that reports nothing is the *normal* case on this platform,
and treating "learned nothing" as "forget the position" would wipe a good
position every time the user tried a silent source.

**What this gets you:** a real resume point and a real progress bar, and
`on.episodeWatched` firing for the first time, so watching something on the
phone moves the library forward the way it does on the desktop.

**What it does not:** *seeking* to a stored position. Reading a number out of a
frame and writing one back are not symmetric, and nothing here can write. In
practice the providers that report progress also restore it themselves, so the
video resumes anyway — but that is their feature, not ours, and the app cannot
fix it when they get it wrong.

**Stall detection and the auto-switch countdown are still missing**, and for a
reason that will not go away: they need to know a video *stopped* advancing, and
a provider that never reports is indistinguishable from one that has stalled.
`player.dismissSuggestion` stays a no-op because nothing can raise a suggestion.

### What an outcome now means

A play used to be recorded as a successful stream the instant its URL was handed
to the iframe. That marked every attempt a success, so the source picker's dots
were green across the board and `automaticOrder` saw an unbroken run of wins for
everything ever opened. It was not a ranking, it was a list of things that had
been clicked.

Outcomes are now settled on *leaving* a provider, with three answers:

- **stream** — it reported a position, or it held the screen for a minute.
- **failed** — the user switched away from it inside twenty seconds. Only
  switching counts; closing the player quickly means they changed their mind
  about watching, which says nothing about the source.
- **nothing at all** — anything else. This is the important one. A provider that
  demonstrated neither success nor failure stays exactly where the user's own
  ordering put it, and guessing in either direction is what produced the useless
  ranking in the first place.

**The chrome bar does not auto-hide.** On desktop it fades and returns when the
pointer nears the top edge, half of that signal arriving from the player view's
preload. A phone has no pointer, and a tap inside a cross-origin iframe is
invisible to us — so an auto-hiding bar would hide once and never come back,
stranding the user in a full-screen video. `PlayerChrome`'s `touch` prop pins
it open.

The bar itself is the desktop's `PlayerChrome.svelte`, mounted into this
document by `bridge/chromeoverlay.ts` rather than into a second
`WebContentsView`. It can be, because here the video surface is a DOM node and
not a native layer — so ordinary z-index puts the chrome in front of it.


## The provider catalogue is managed here too

Embed providers die and change domain constantly, so the list is fetched rather
than compiled in — and a list compiled into an *APK* is the worst case of that,
because the user cannot rebuild the app. The phone ran on its bundled list until
`catalog.ts` was made storage-agnostic.

The split is one interface. `CatalogStore` is `read(): Promise<string | null>`
and `write(blob)`, and everything that makes the managed catalogue work — the
URL, the ETag round trip, the all-or-nothing validation, the bundled/remote/
custom resolution — stayed in the shared module. The desktop backs it with a
JSON file; `bridge/catalogstore.ts` backs it with Capacitor Preferences, which
is `SharedPreferences` underneath.

Not the app's own store, deliberately: the catalogue is a cache of a public
document, and putting it in `watchthemall.json` would send a hundred providers
of public information through migration, through the sync merge and into every
export, for devices that can each fetch them in a second.

The refresh is fire-and-forget on launch, throttled to the desktop's twelve
hours. Nothing waits for it — the bundled list works — and a failure is not
surfaced, because an error about a background refresh the user never asked for
describes a problem they cannot act on.

## Notifications, without a background process

A Capacitor app is a WebView: when Android stops the activity the JavaScript
stops with it, so the desktop's release timer has nowhere to live. A
`WorkManager` worker would run, but it cannot call into the WebView — it would
need the TMDB client reimplemented in Kotlin.

So the sweep did not move to the background; the *notification* did. TMDB knows
the date the next episode airs, and `AlarmManager` will deliver a notification
weeks out with the app closed — `@capacitor/local-notifications` even
re-registers pending alarms after a reboot. Every time the app is open it
rebuilds the whole schedule from the trackers, so a corrected air date fixes
itself on the next launch. A sweep also runs on `resume`, throttled to once an
hour.

Alarms are inexact on purpose: an episode notification is worth the same
whether it lands at 09:00 or 09:20, and exact ones need `SCHEDULE_EXACT_ALARM`,
which Android does not grant without sending the user to a settings page.

**Saying so takes `isExactNotification: false`, not `allowWhileIdle: false`.**
Those are different flags and only the first one is about exactness; the second
is about waking the device out of Doze. Setting the wrong one meant every
notification asked for an exact alarm, and the plugin — which declares
`SCHEDULE_EXACT_ALARM` in its own manifest, so the app inherits it — responded
by launching the "Alarms & reminders" settings page and leaving `schedule()`
unresolved. Measured: the user was ejected from the app and **no notification
was ever posted**. Every release sweep did it. If notifications ever go quiet
again, check that flag before anything else.

Tapping a notification opens the Releases tab, which is what the desktop's
notification click handler does.

## Other platform behaviour

- **Back button and gesture.** Back leaves the player, then closes an open
  overlay, then quits. `enableOnBackInvokedCallback` opts into the platform back
  API so the predictive gesture animates; it is safe alongside the JS listener
  because Capacitor 8 registers through AndroidX's `OnBackPressedDispatcher`.
- **The screen stays awake while something plays**, via the Screen Wake Lock
  API — no plugin, no permission. A WebView holds no wake lock for an embed
  player's `<video>`, so without it the screen locks mid-episode.
- **Fullscreen rotates to landscape** and hides the status bar, then restores
  both on exit. Only on fullscreen, never on play: rotating the screen out from
  under someone watching in bed is how an app gets uninstalled.
- **Signing in can be done on the phone itself.** Pairing shows an address and
  a code, and the panel adds a button for each: one opens the address in a
  Custom Tab, which shares the system browser's cookies and so usually lands on
  a page already signed in, and one copies the code. Both are shortcuts over a
  flow that still works without them — the address and code stay on screen,
  because a button that silently fails must not be the only way through.
- **The store flushes on `pause`.** Writes are debounced 400ms, which is right
  in the foreground and wrong the instant Android may kill the process.
- **An unreadable store is quarantined** to `watchthemall.corrupt.json` before
  the app starts empty, so "restore from a backup" stays possible.
- **A startup failure renders a readable panel** rather than a white screen.

## Icons

`mobile/assets/*.svg` are the source; `scripts/generate-android-icons.sh`
renders every density with `rsvg-convert`, including the adaptive-icon
foreground and a monochrome layer for Android 13 themed icons. The output is
committed so a clone does not need librsvg.

## Signing

The APK is debug-signed, which is enough to sideload and is what
`assembleDebug` produces. It is *not* enough for the Play Store, and a debug
key is regenerated per machine — an APK built here cannot upgrade one built
elsewhere, it has to be uninstalled first.
