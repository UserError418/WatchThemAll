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

## What is missing, and why

**Position tracking, stall detection, and the auto-switch countdown.** These
need to read a `<video>` inside a cross-origin document. On desktop that is a
privilege of the Electron embedder — `WebFrameMain.executeJavaScript` runs in
any frame regardless of origin — and neither a WebView nor an iframe grants
anything like it. So there is no resume-to-exact-position and no automatic
recovery from a dead source; `player.dismissSuggestion` stays a no-op because
nothing can raise a suggestion. Switching source by hand does work.

The same blindness is why a play is recorded as a *successful* stream: nothing
here can observe whether it played, and recording every play as a failure would
poison the ranking that decides what to open next time.

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

**The remote provider catalogue.** The desktop app refreshes the catalogue in
the background and caches it to disk. The phone ships whatever catalogue its
APK was built with. That is a staleness problem rather than a correctness one,
and the custom-provider form covers the urgent case.

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

Alarms are inexact on purpose: exact ones need `SCHEDULE_EXACT_ALARM`, which
Android 14 does not grant without sending the user to a settings page, and an
episode notification is worth the same whether it lands at 09:00 or 09:20.

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
