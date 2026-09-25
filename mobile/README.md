# WatchThemAll for Android

The same app on a phone. The Svelte renderer, the design system and the whole
business layer are the desktop ones, built by a second Vite config and wrapped in
a Capacitor WebView.

```bash
npm run build:mobile     # web bundle -> out/mobile
npm run sync:mobile      # copy it into the Gradle project
npm run apk              # both of the above, then assembleDebug
```

The APK lands at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
Building needs JDK 21 and the Android SDK; `scripts/provision-android.sh`
installs both.

## Why this is a port

The renderer's entire contact with the platform is one interface — `WtaApi` in
`src/shared/ipc.ts`, 26 methods and ten event subscriptions. Eighteen renderer
files call `window.wta` and nothing else, so the phone app needs one new thing: a
second implementation of that interface, in `mobile/src/bridge/`.

| Layer | Shared? | Notes |
|---|---|---|
| `src/renderer/**` | verbatim | Every view, component and style. |
| `src/shared/**` | verbatim | Types, the IPC contract, the store. |
| `src/main/tmdb.ts`, `imdb.ts`, `search.ts` | verbatim | Plain `fetch`. |
| `src/main/providers.ts`, `outcomes.ts` | verbatim | Pure functions. |
| `src/main/migrate.ts`, `sync.ts` | verbatim | Same document, same export format. |
| `src/main/malimport.ts`, `malapply.ts` | verbatim | Parser is `DOMParser`-free. |
| `src/main/taste.ts`, `releases.ts` | verbatim | `releases` takes a structural store. |
| `src/main/catalog.ts` | verbatim | Storage behind a port. |
| `src/main/store.ts` | replaced | Node `fs` → `bridge/store.ts`. |
| `src/main/playerview.ts`, `windows.ts` | not ported | Replaced by `bridge/playersurface.ts`. |

This held because the business layer never imported Electron or Node, which the
`lint-imports` contract has enforced since before the port.

Two things made the rest fit:

**`CapacitorHttp` is enabled.** The WebView serves the app from
`https://localhost`, so every TMDB and IMDB call is cross-origin. TMDB sends
permissive CORS headers; IMDB's suggestion endpoint does not, and it is the only
path to the IMDB ids providers key on. Routing `fetch` through the native HTTP
stack removes the same-origin check from the question, so `tmdb.ts` and `imdb.ts`
needed no edits.

**The layout is mostly token retuning.** Svelte scopes component styles with a
hash class, so a plain `.grid` rule in a global sheet loses to
`.grid.svelte-abc123` — winning that across forty rules means `!important`
everywhere or forked components. Custom properties cascade normally and the
components already read them for every dimension that matters, so
`mobile/src/styles/mobile.css` is mostly twenty token values. Only the bottom tab
bar and full-bleed sheets need real selectors.

## The player

Playback runs inside the app, in an iframe the bridge positions wherever the
renderer's player chrome says the video goes. The desktop shape is unchanged —
the platform layer owns a video surface, the renderer owns the chrome over it.
Only the surface differs: a `WebContentsView` there, an `<iframe>` here. Every
provider URL is an embed endpoint, and none of the core providers sends a
restrictive `X-Frame-Options` or `frame-ancestors`.

Because the surface is a DOM node rather than a native layer, ordinary z-index
orders it: the iframe at 299, `PlayerFrame`'s transparent slot at 300, the chrome
host at 400. Anything that must sit over the video goes in the chrome host.

### Ad blocking is native, not `sandbox`

The first version played in a Chrome Custom Tab. Every provider in the catalogue
monetises with popunders, and a Custom Tab is a real browser tab the app controls
nothing inside, so the phone showed ads the desktop never does.

The obvious fix — the iframe's `sandbox` attribute — is worse than the problem.
**Several providers test for it and refuse to serve**; one replaces its page with
"Please Disable Sandbox". Verified both ways on an Android 16 emulator, same URL
seconds apart.

Two native settings give the same guarantees and cannot be detected by a page:

- `setJavaScriptCanOpenWindowsAutomatically(false)` in `MainActivity` makes
  `window.open` return `null` in every frame.
- `PlayerNavigationClient` refuses main-frame navigation to a third party while
  allowing navigation *within* the player frame. Without it, Capacitor's
  `shouldOverrideUrlLoading` fires an `ACTION_VIEW` intent on an ad redirect and
  drops the user into Chrome.

Together these match the desktop: an ad can replace the picture inside the
player and do nothing to the app around it. The APK stays a web bundle plus two
dozen lines of Java that only configure the WebView.

### Progress, without reading the video

The desktop reads `currentTime` off the provider's `<video>` via
`WebFrameMain.executeJavaScript`, which works in any frame regardless of origin.
Neither a WebView nor an iframe grants anything like it. **Several providers post
their position out to whatever frames them**, which is the way in:

| Provider | Posts | Carries |
|---|---|---|
| VidFast | `PLAYER_EVENT`, `MEDIA_DATA` | position, duration, season, episode, tmdb id |
| Videasy | `PLAYER_EVENT` | position, duration, season, episode, tmdb id |
| VidLux, VidFlix, VidRock | nothing | — |

`src/main/playermessage.ts` parses them — pure, in the business layer, tested
against transcribed payloads. Two rules in it are load-bearing:

- **Check the sender, not the origin.** `event.source === frame.contentWindow` is
  a window-identity comparison that works cross-origin and cannot be forged. An
  origin allowlist rejects working players, because providers redirect through
  their own CDNs.
- **Every reading must name its title.** VidFast's `MEDIA_DATA` is its entire
  progress library; picking an entry means guessing which one is on screen, and
  the guess is wrong for the first message of every session.

Thresholds come from `@main/resume` rather than being restated, including the
three-way `resumeAction`. That matters more here than on desktop: a provider
reporting nothing is the *normal* case, and treating "learned nothing" as "forget
the position" would wipe a good position whenever the user tried a silent source.

### History records the play, not just the tap

The desktop's `settleProgress` and this bridge's both measure how long a play
ran, in order to decide whether it counts as watched — and both used to throw
the number away once the verdict was taken. `playbackSettled` carries it out
every time now, which is what fills the History tab's durations.

It matters more here than on the desktop. Most providers report no position on
Android, so for many plays that event is the *only* record that anything
happened beyond the tap that started it.

### What an outcome means

A play used to count as a successful stream the instant its URL reached the
iframe, which made the ranking a list of things that had been clicked. Outcomes
now settle on *leaving* a provider:

- **stream** — it reported a position, or held the screen for a minute.
- **failed** — the user switched away inside twenty seconds. Only switching
  counts; closing the player quickly means they changed their mind about
  watching, which says nothing about the source.
- **nothing** — anything else. A provider that showed neither success nor failure
  stays where the user's own ordering put it.

### Testing every source, with one capture buffer

"Test all sources" loads each enabled provider in turn and reports whether it
fetched a stream. The signal is the hook casting uses:
`shouldInterceptRequest` on the app's `WebViewClient` fires for every
subresource of every frame, cross-origin included, and lands in `MediaCapture`.

That buffer records a URL without recording which frame asked for it, because
`shouldInterceptRequest` is not told. Three rules follow, and none is optional:

- **One provider at a time.** Two in flight share one undifferentiated pile of
  requests, and both get credited with whatever either fetched.
- **Playback stops for the duration.** A player streaming in the background
  fills the buffer several times a second, which turns every provider the scan
  touches green. `PlayerSurface.blank()`/`restore()` suspends it, the same pair
  casting uses when it needs the network to itself.
- **Six seconds of settling between providers.** An HLS player keeps pulling
  segments after its document is gone, long enough for a dead provider to be
  credited with its predecessor's stream.

**A URL is not always enough to recognise a stream.** The buffer holds requests,
never responses, so the desktop's strongest signal — the response's content
type — is missing. Most providers name their media (`.m3u8`, `.mp4`, `.mkv`),
and the scan matches those for free. Some stream through opaque proxy paths
instead, such as `…/api?d=<token>` for every playlist and segment. For those
the scan fetches the newest few captured requests with their original headers,
a dozen at most per provider, and reads the content type and first line, which
is how the cast feature already decides what it can hand a television.

**Quality comes from the stream, never from the page.** Once a provider
streams, the scan reads its oldest few captured playlists the same way — the
master comes first, and it is the only playlist that lists renditions with
their sizes — and parses them with the desktop's own parser
(`src/shared/streamquality.ts`). A source with no master serves one rendition,
and that rendition states its own size in its first bytes: the fMP4 init
segment, or the H.264 header at the start of the first MPEG-TS segment. The
scan fetches the first 64 KB of it (`capture.peekBytes`, which asks
`fetchText` for base64 so the binary arrives intact) and reads it with the
shared parsers (`src/shared/streamheader.ts`), but only from a playlist at least
ten minutes long, since an ad served as its own playlist states its size just
as plainly. The desktop can also read the picture's size off the provider's
`<video>`, which is the answer for a source serving one whole MP4 or MKV file.
The phone cannot reach into a cross-origin frame, so those sources show no
quality here.

**The probe surface is visible because it has to be.** Several providers resolve
no stream until something clicks, and a cross-origin iframe can only be clicked
by a real touch at real coordinates — `ScanPlugin.tap` dispatches a
`MotionEvent` to the WebView, which hit-tests it against its own DOM regardless
of origin. A touch needs somewhere to land, so an off-screen or zero-sized frame
cannot be tapped and any provider wanting one would be reported dead.

### The chrome bar does not auto-hide

On desktop it fades and returns when the pointer nears the top edge. A phone has
no pointer and a tap inside a cross-origin iframe is invisible, so an auto-hiding
bar would hide once and never come back. `PlayerChrome`'s `touch` prop pins it
open; the bar itself is the desktop's component, mounted by
`bridge/chromeoverlay.ts`.

## The provider catalogue

A list compiled into an APK is the worst case of a stale catalogue, because the
user cannot rebuild the app. `CatalogStore` is `read()` and `write(blob)`, and
everything that makes the managed catalogue work — the URL, the ETag round trip,
the all-or-nothing validation, the bundled/remote/custom resolution — stays in
the shared module. Desktop backs it with a JSON file, `bridge/catalogstore.ts`
with Capacitor Preferences.

Deliberately not the app's own store: the catalogue is a cache of a public
document, and putting it in `watchthemall.json` would push a hundred providers of
public information through migration, through the sync merge and into every
export.

Refresh is fire-and-forget on launch, throttled to twelve hours. Nothing waits
for it and failures are not surfaced, because an error about a background refresh
the user never asked for describes a problem they cannot act on.

## Notifications, without a background process

When Android stops the activity the WebView's JavaScript stops with it, so the
desktop's release timer has nowhere to live. A `WorkManager` worker would run but
cannot call into the WebView; it would need the TMDB client rewritten in Kotlin.

So the notification moved instead of the sweep. TMDB knows the air date and
`AlarmManager` delivers weeks out with the app closed;
`@capacitor/local-notifications` re-registers pending alarms after a reboot. Every
launch rebuilds the schedule from the trackers, so a corrected air date fixes
itself. A sweep also runs on `resume`, throttled to once an hour. Tapping a
notification opens the Releases tab.

Alarms are inexact on purpose — a release notification is worth the same at 09:00
or 09:20, and exact ones need `SCHEDULE_EXACT_ALARM`, which Android will not grant
without sending the user to a settings page.

**Requesting that takes `isExactNotification: false`, not `allowWhileIdle:
false`.** Only the first is about exactness; the second is about waking the device
out of Doze. Set the wrong one and every notification requests an exact alarm, at
which point the plugin — which declares `SCHEDULE_EXACT_ALARM` in its own
manifest, so the app inherits it — launches the "Alarms & reminders" settings page
and leaves `schedule()` unresolved. Nothing is ever posted and the user is ejected
from the app. If notifications go quiet, check that flag first.

## Other platform behaviour

- **Back** leaves the player, then closes an open overlay, then quits.
  `enableOnBackInvokedCallback` opts into the platform back API so the predictive
  gesture animates, which is safe alongside the JS listener because Capacitor 8
  registers through AndroidX's `OnBackPressedDispatcher`.
- **The screen stays awake during playback** via the Screen Wake Lock API. A
  WebView holds no wake lock for an embed player's `<video>`.
- **Fullscreen rotates to landscape** and hides the status bar, restoring both on
  exit. Only on fullscreen, never on play.
- **Sync pairing can be completed on the phone.** Buttons open the pairing address
  in a Custom Tab, which shares the system browser's cookies and usually lands on
  a page already signed in, and copy the code. Both are shortcuts — the address
  and code stay on screen, because a button that silently fails must not be the
  only way through.
- **The store flushes on `pause`.** Writes are debounced 400ms, which is right in
  the foreground and wrong the instant Android may kill the process.
- **An unreadable store is quarantined** to `watchthemall.corrupt.json` before the
  app starts empty, so restoring from a backup stays possible.
- **A startup failure renders a readable panel**, not a white screen.

## Known limitations

Differences from the desktop that are not closing soon.

- **Seeking to a stored position.** Reading a number out of a provider's frame
  and writing one back are not symmetric, and nothing here can write. Providers
  that report progress generally restore it themselves, but that is their feature
  and the app cannot correct it when they get it wrong.
- **Stall detection and the auto-switch countdown.** Both need to know a video
  *stopped* advancing, and a provider that never reports is indistinguishable from
  one that stalled. `player.dismissSuggestion` is a no-op.
- **Automatic watched detection on silent providers.** `isWatchedEnough` runs fine
  here but has nothing to feed it, so those titles are marked by hand. Injecting a
  script from a Kotlin `WebViewClient` is the only obvious route, and
  `evaluateJavascript` reaches the main frame only — most providers nest their
  player an iframe deeper.
- **The release-check interval setting is inert.** Alarms come from known air
  dates and the sweep runs on resume, so there is nothing for it to control.
- **The refresh token is in `Preferences`, not the Android keystore** — private
  app storage, readable by this app and by root. The keystore needs a native
  Kotlin module and this project has none. The library file sits behind the same
  boundary, so the token is no less protected than the data it unlocks.
- **Export goes through the system share sheet**, not a save dialog. There is no
  "save to this folder" without the Storage Access Framework.
- **No keyboard shortcuts or menu bar.** The chrome bar's controls are the
  substitute.

## Icons and signing

`mobile/assets/*.svg` are the source; `scripts/generate-android-icons.sh` renders
every density with `rsvg-convert`, including the adaptive-icon foreground and a
monochrome layer for Android 13 themed icons. The output is committed so a clone
does not need librsvg.

The APK is debug-signed, which is enough to sideload and is what `assembleDebug`
produces. Debug keys are per machine, so an APK built here cannot upgrade one
built elsewhere without uninstalling first.
