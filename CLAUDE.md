# WatchThemAll — Electron desktop stream navigator

Cross-platform Electron app for navigating third-party video embed pages,
browsing TMDB's catalogue, tracking watch progress, and being told when new
episodes air. Cloned onto this machine 2026-09-06 from
`UserError418/WatchThemAll` and rewritten the same day.

The app hosts and streams nothing. It builds provider URLs, opens them in a
player window, and owns everything around that.

## Commands

```bash
npm install
npm run dev         # electron-vite with hot reload
npm run lint        # eslint
npm run typecheck   # tsc --noEmit && svelte-check
npm test            # vitest
npm run build       # all three targets into out/
npm run build:linux # + electron-builder (also :win, :mac)

npm run apk         # the Android build: web bundle -> cap sync -> assembleDebug
```

The APK needs JDK 21 and the Android SDK; `scripts/provision-android.sh`
installs both and documents why the system JDK 26 will not do.

**`build:win` needs `wine` on PATH**, and fails in the worst possible way
without it: electron-builder exits 0, writes a **547 KB stub** next to a
separate `.nsis.7z` payload, and that stub is an installer that cannot install
anything. Wine is what runs `rcedit` and `signtool`, both Windows binaries, to
put the icon and the version resource into the exe. Releases 1.3.0 through
1.5.1 shipped with no Windows artefact because of it. A real installer is
around 100 MB; `scripts/ship.sh` now asserts both the presence of wine and the
size of what comes out. The phone app is
the same Svelte renderer with a different `window.wta` — see
[`mobile/README.md`](mobile/README.md).

**All four gates must pass before a commit.**

## Architecture

Three processes, built by `electron-vite`. Svelte 5 + TypeScript, no other
runtime dependencies.

```
src/
  main/        Node: windows, store, TMDB client, providers, release sweep, IPC
  preload/     two bridges — the app API, and the player-window controls
  renderer/    Svelte 5: views/, components/, lib/ (reactive library state)
  shared/      domain types + the IPC contract, imported by all three
mobile/        the Android app: a second window.wta over the same renderer
legacy/        the original app, verbatim
```

**`src/main` is not "the Electron process", it is the business layer.** Only
`store.ts`, `windows.ts`, `menu.ts`, `playerview.ts`, `catalog.ts` and
`localserver.ts` touch Node or Electron; TMDB, IMDB, search, providers,
outcomes, migrate, sync, taste, releases and the MAL importer are plain
TypeScript over the store document. That is what made the Android port a port
rather than a rewrite — do not casually import `electron` into one of them.

`src/shared/ipc.ts` is the contract. All three processes import it, so a channel
the renderer can name but main does not handle is a compile error — and main
asserts at startup that every channel in the contract has a handler.

**The renderer makes no network requests.** Every TMDB call goes through the
main process, which is what lets the app window run with `webSecurity: true`
behind a CSP permitting only local files and `image.tmdb.org`. Player windows
are the exception by necessity and are locked down in every other respect.

Design decisions and their reasoning: `docs/ARCHITECTURE.md` — present in a
working copy, gitignored, and **not published**, so it is a plain path rather
than a link. **Read its "Hard-won constraints" section before touching the IPC
boundary, season/episode positions, or provider selection** — each entry there
is a bug that already happened once. `docs/CYCLE-2.md` and `docs/SYNC.md` are
the same: local, maintained, unpublished.

## Testing

Vitest. 539 tests across thirty-two suites, concentrated on the code where
being wrong is silent rather than loud:

- `migrate.test.ts` — schema migration and position repair. It runs on **every
  load**, not once at a version change, against data the user cannot get back.
  Believing otherwise is what let it quietly rewrite `updatedAt` on every launch
  and disable the sync merge's last-write-wins; the tests now compose `migrate`
  with `merge`, because each was correct alone.
- `sync.test.ts` — the export format, which is frozen and shared with the
  Android app and the ReelVault extension.
- `providers.test.ts` / `playback.test.ts` — URL template substitution and
  provider selection.
- `format.test.ts` — the strings the user reads, each of which has an edge case
  that renders as visible nonsense rather than throwing.

## Running it from a session on this box

**Run it under Xvfb, not against the desktop's display.** Chromium refuses to
run as root without `--no-sandbox`, and a window opened on the KDE/Wayland
session from a root session comes up with `document.hidden === true`.

That last point is the one that wastes a day. A hidden window gets **no
rendering lifecycle at all**, and three things silently stop happening:
`requestAnimationFrame` never runs, `IntersectionObserver` never delivers, and
**scroll events never fire**. Everything built on those looks broken while being
perfectly healthy — lazily-loaded rows stay empty forever and the nav never
turns solid. It is one environment fact, not three bugs.

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
DISPLAY=:99 node_modules/electron/dist/electron . --no-sandbox --remote-debugging-port=9333
```

Under Xvfb the page reports `visibilityState: 'visible'` and all three work.

**Verify the UI over CDP.** `scripts/cdp.py` is the client — standard library
only, so it works when `node_modules` is broken:

```bash
python3 scripts/cdp.py 'document.querySelectorAll(".card").length'
python3 scripts/cdp.py --screencast --screenshot /tmp/app.png 'document.title'

# Inside the provider's frame. `--match` defaults to the app window and
# `--target-type` to `page`, which deliberately excludes iframes — so reaching
# a player's <video> takes both flags.
python3 scripts/cdp.py --match player.videasy.to --target-type iframe \
  'document.querySelector("video")?.currentTime'
```

CDP yields assertable facts — which image origins loaded, CSP violations, DOM
counts — rather than a picture somebody has to interpret, so it is the first
tool to reach for. `Page.captureScreenshot` also works; pass `--screencast`
first, or the first frame comes back with the text painted and the images
missing.

**Screen capture of the whole screen works, and for the player it is the only
thing that does.** An earlier version of this file said capture "does not work
here at all". That is true of rootless XWayland and false of Xvfb, and
believing it is how a player chrome shipped that had never once appeared for a
user. CDP cannot see the player: the video and the chrome are native
`WebContentsView`s composited by the window, so `Page.captureScreenshot`
against any one target returns that target alone. Only the X root window holds
the composite.

```bash
DISPLAY=:99 import -window root /tmp/shot.png
DISPLAY=:99 xdotool mousemove 960 700 sleep 0.4 mousemove 960 20   # a real pointer
```

`xdotool` matters as much as the capture. A synthesised DOM event cannot test
chrome that is summoned by the pointer, because the thing under test is whether
the pointer reaches the right view at all — and a cross-origin embed is exactly
where it stops doing so.

**Anything drawn over the video is not done until it has been seen this way.**
Lint, typecheck and the whole suite pass happily on a chrome nobody can open.

Images below the fold report `naturalWidth === 0` because they are
`loading="lazy"`. That is the design working; scroll to them and re-check.

## Running the Android app from a session on this box

**The emulator is the only honest test for the phone build.** The Chromium
harness in `scripts/preview-mobile.cjs` gets the layout right and gets three
things wrong that matter: it is not an Android WebView, so it does not have
Capacitor's inset handling, its scrollbars, or its navigation policy — and
every Android-only fault found in September 2026 lived in exactly those three.

```bash
# One-time: the SDK ships neither of these.
sdkmanager --install "emulator" "system-images;android-36;google_apis;x86_64"
avdmanager create avd -n wta -k "system-images;android-36;google_apis;x86_64" -d pixel_7

# Run it under systemd, not from the session. It SEGVs in SwiftShader every
# twenty minutes or so under sustained video, and `Restart=always` is the
# difference between a lost afternoon and a two-minute gap.
systemd-run --unit=wta-emulator --collect --property=Restart=always \
  --setenv=ANDROID_HOME=/opt/android-sdk --setenv=ANDROID_AVD_HOME=/root/.android/avd \
  /opt/android-sdk/emulator/emulator -avd wta -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -memory 4096 -no-snapshot-save

npm run apk && adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

**Drive it with `scripts/android-ui.py`, not with CDP clicks.** A debug build
turns on `setWebContentsDebuggingEnabled`, so `adb forward tcp:9222
localabstract:webview_devtools_remote_<pid>` gives `scripts/cdp.py` the same
session the desktop app exposes directly — and a click dispatched through it
proves the handler works while saying nothing about whether a finger can reach
the element. Every Android layout fault here passed a synthetic click:

```bash
scripts/android-ui.py tap '.hero .play' --settle 5   # a real `input tap`
scripts/android-ui.py rect '.player'                 # CSS and device rects
scripts/android-ui.py eval 'innerHeight'             # straight to cdp.py
adb exec-out screencap -p > /tmp/shot.png            # the device framebuffer
```

It converts CSS coordinates to device pixels itself, including the offset down
the screen — which is not zero, because Capacitor lays the WebView out *between*
the system bars on any WebView below version 140.

**Two measurements that look equivalent and are not.**

- *Did the picture move* (`compare -metric RMSE` over two `screencap`s) is
  satisfied by a spinner and by an ad, and **not** satisfied by a provider
  streaming perfectly while paused on its first frame waiting for a tap.
- *Did it fetch a stream* (`scripts/android-provider-probe.py`, which reads
  `Network.*` events off the WebView session) is satisfied by a provider whose
  page has already been replaced by a refusal notice, because its player keeps
  resolving in the background. VidFast scored 106 media requests while showing
  "Please Disable Sandbox".

Neither alone is a verdict. Use the probe to find which providers fetch, and a
screenshot to confirm what the user is actually looking at.

**A provider's traffic outlives its document.** An HLS player keeps pulling
segments for several seconds after the iframe is navigated away, so a sweep
that switches provider and starts counting immediately credits each one with
its predecessor's stream. Blank the surface, wait, then count — the probe does.

**A provider's position can be read, and the way to check is to listen.** Some
providers `postMessage` their playback position to the framing window — see
`src/main/playermessage.ts` for the measured payloads. Surveying a new one takes
one paste into the running app:

```js
window.__m = []
addEventListener('message', (e) => {
  if (e.source === document.querySelector('#wta-player-surface iframe')?.contentWindow)
    window.__m.push(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))
})
```

Give it thirty seconds *with the video actually playing* — several providers say
nothing at all until their `<video>` exists, and a survey taken off the poster
screen concludes they are silent when they are not.

**The app's own layers, and what may paint over what.** The video is an
`<iframe>` at z-index 299, `PlayerFrame`'s slot is a transparent hole at 300,
and `PlayerChrome` is mounted into its own host at 400. This is the inverse of
the desktop, where the video is a native view that always paints over the page.
Anything new that must sit over the video goes in the chrome host.

Data lives in `/root/.config/watchthemall/data/watchthemall.json`. Back it up
before any test that resets it.

## Casting to a TV (Android)

The phone can put a provider's stream on a Chromecast. It is not "send the
video" — the app never holds one — so it captures what the provider's player
fetched off `shouldInterceptRequest`, decides which capture is a stream **by
fetching it rather than by matching `.m3u8`**, rewrites the playlist so every
URL in it points back at a small HTTP server on the phone, and casts that. The
server replays the provider's `Referer`; a Chromecast sends none and the Cast
API cannot attach one, because the receiver does the fetching.

`src/main/hlsrewrite.ts` holds every part of that which can be a pure function,
deliberately: the proxy has to be Java and nothing there is covered by the four
gates. `docs/internal/casting.md` (local, unpublished) has the diagram, the
verification table and the known limits.

Two things to know before changing any of it:

- **A proxied playlist that has not been rewritten still names the provider's
  hosts**, so the receiver fetches segments directly, without headers, and the
  stream dies several seconds in — long after the manifest loaded cleanly.
- **No proxy route takes a URL.** Ids are registered up front. The query-string
  design would make the phone an open relay for the network while a cast runs.

```bash
npx vite-node scripts/cast-proxy-check.ts -- --extract /tmp/e.json  # mpv is the judge
```

## legacy/

The original app is preserved verbatim and still runs:

```bash
npm run legacy:start    # the original Electron app
npm run legacy:test     # its 25 tests
```

It is kept because it is the only complete specification of the behaviour that
was reimplemented — subtleties in episode tracking, provider fallback and the
export format are documented nowhere else. Delete it at feature parity, not
before.

Its origin explains a lot about it: generated in one pass by a weaker model,
then ported from the ReelVault Chrome extension without unwinding the
extension's assumptions. Several files still carry `ReelVault —` headers and
call `chrome.storage.local` through a preload shim.
