# Architecture

A desktop and Android client for watching TV and film through third-party embed
providers. It hosts and streams nothing itself: it builds provider URLs, frames
them, and owns everything around that — knowing what exists, where you left off,
and when the next episode lands.

## Processes

An Electron three-target split, built by `electron-vite`.

```
src/main/        Node. Windows, menu, tray, store, TMDB client, IPC handlers.
src/preload/     The only bridge. A typed, enumerated API surface.
src/renderer/    Svelte 5 + TypeScript. No Node, no direct network access.
src/shared/      Types and the IPC channel contract, imported by all three.
```

`src/main` is the business layer, not "the Electron half". Only `store.ts`,
`windows.ts`, `menu.ts`, `playerview.ts`, `catalog.ts` and `localserver.ts`
touch Node or Electron. TMDB, IMDB, search, providers, outcomes, migration,
sync, taste and releases are plain TypeScript over the store document, which is
what let the Android app reuse them unchanged. Importing `electron` into one of
them breaks that, and `lint-imports` enforces it.

`src/shared/ipc.ts` is the contract. All three processes import it, so a channel
the renderer can name but main does not handle is a compile error, and main
asserts at startup that every channel has a handler.

**The renderer makes no network requests.** Every TMDB call goes through main,
which owns the API key, the cache and the rate limiting. That is what allows
`webSecurity: true` on the app window behind a CSP permitting only local files
and `image.tmdb.org`.

Player windows are the exception. They load untrusted third-party pages and need
`webSecurity: false`, because video CDNs are cross-origin from the embed page.
They are isolated in every other respect: no Node, context isolation on, all
pop-ups denied, and a preload that speaks over one narrow channel.

## Data sources

**TMDB** provides browse rows (`trending/*`, `tv/top_rated`, `tv/on_the_air`,
`discover/tv`), show and season detail, air dates via `next_episode_to_air`, and
all artwork.

**IMDB's suggestion endpoint** provides general search. Both sources are needed:
providers key their URLs on IMDB ids, and TMDB search returns a TMDB id that
needs a second `external_ids` round trip — or has no `imdb_id` at all, which
makes the title unplayable rather than merely slower.

## Storage

One JSON file at `{userData}/data/watchthemall.json`, written atomically through
a temp file and rename. Writes are debounced and coalesced. The document is
namespaced and typed.

SQLite was considered and rejected: the data is a few hundred records, and
`better-sqlite3` is a native module that complicates every `electron-builder`
target for no benefit at this size.

The export/import format in `src/main/sync.ts` is **frozen**. It is the
interchange format shared with the Android app and the ReelVault extension, and
it is deliberately narrower than the internal document — it cannot grow fields
the extension does not understand. That is why it makes good interop and a poor
sync basis; cross-device sync uses `src/shared/store` instead. See
[SYNC.md](SYNC.md).

## Information architecture

- **Browse** — the default view. A full-bleed hero, then horizontally scrolling
  rows: Trending, Because You Like *(top genre)*, Top Rated, New & Upcoming, and
  per-genre rows. Rows load lazily as they enter the viewport.
- **Search** — federated search, results as a card grid.
- **Watchlist** — what you are watching, with resume position, plus the history
  timeline.
- **Releases** — series you have asked to be told about, with countdowns and OS
  notifications.

## Rendering

Svelte 5, chosen because the cost being avoided is re-rendering large lists, and
Svelte compiles to direct DOM updates rather than diffing a virtual tree. A row
of 100 poster tiles should not be a performance decision anyone has to remember
to make.

Two rules follow: no `innerHTML` or string-built markup, and long lists are
windowed to what is in view plus a small buffer.

## Constraints

Each of these is a bug that shipped once. They are not obvious from the code and
a change that does not know them will reintroduce them.

**Reactive state cannot cross the IPC boundary.** Svelte 5 `$state` values are
Proxies, and `structuredClone` — which is what `contextBridge` and
`ipcRenderer.invoke` use — throws on one. Every write goes through
`$state.snapshot()` first. This fails silently: the optimistic UI update has
already happened, so the app looks healthy until it is restarted and the changes
are gone. `library.persistError` exists for that reason and renders as a banner.

**Seasons and episodes are 1-based everywhere.** A zero means a caller failed to
parse something. `setPosition` and `setWatched` reject non-positive values, and
`migrate` repairs stored positions that already hold one.

**"Nothing worth saving" and "forget what was saved" are different answers.**
The resume point is read off the provider's own `<video>`, and many providers
nest that element out of reach, so the routine outcome of a poll is no reading
at all. Treating that as "watched to the end" deletes a good position stored by
a working provider. `resumeAction` in `resume.ts` returns three values, `keep`
is the default, and forgetting requires positive evidence the title is finished.

**Navigating within a title is not leaving it.** A provider switch, a reload and
a crash fallback all stay on the same episode. `settleProgress` decides "watched"
and drains the elapsed-time counter, and that counter is the only progress signal
for a provider with no reachable `<video>` — draining it on every switch splits
one episode into stretches too short to count. Settling belongs to `closePlayer`
and `navigatePlayer`, where the title actually changes.

**A disabled provider is never a fallback.** If nothing enabled can serve a
title, that is an error with a reason, not a cue to try something else.

**The player window is told what it is showing.** It does not read its own URL.
Main knows which template built it and sends the context over `EV.playerContext`;
navigation goes back over `EV.playerNavigate` and is rebuilt from the same
template. Guessing from the URL mis-detects episodes whenever a path contains
other digits.

**A cross-origin iframe hides the pointer from the view containing it.**
Chromium hit-tests the first move and then routes pointer events straight to the
target widget, which on a playing embed is the provider's out-of-process iframe.
`webContents.on('input-event')` therefore reports the position where the pointer
entered the view and nothing after. Player chrome is summoned by a live strip
the overlay keeps along the top edge (`HOT_ZONE_PX`), which needs no cooperation
from the page.

**Detaching a `WebContentsView` does not close it.** `removeChildView` takes it
out of the window tree and leaves the web contents running in its own process.
Teardown must call `view.webContents.close()`.

**Anything drawn in the app window paints *under* the video, so it cannot be a
dialog.** Player chrome, the source list and the failed-source banner live in a
second transparent `WebContentsView` stacked above the player. The obligation
that comes with it: the overlay swallows every mouse event inside its bounds, so
it reports its measured height to main and is sized to exactly what it draws.

**`electron-vite` 5 does not support Vite 8**, and `@sveltejs/vite-plugin-svelte`
7 requires it. The working combination is Vite 7 with plugin-svelte 6. Do not
resolve the conflict with `--legacy-peer-deps`.

**The renderer's Vite root is `src/renderer`**, so `build.outDir` must be
absolute or the bundle lands in `src/renderer/out` and gets linted as source.

## Testing

Vitest. Coverage is concentrated where being wrong is silent rather than loud:
store migration, the export/import merge, and URL template substitution. Each of
those suites exists because that code shipped a defect once.

`migrate` and `merge` are tested **composed**, not only separately. A defect once
lived in the seam between them — only `merge` read a field that only `migrate`
corrupted — and both had passing tests.

The UI is verified against the running app over the Chrome DevTools Protocol
rather than by screenshot: launch with `--remote-debugging-port` and evaluate
against the renderer target with `scripts/cdp.py`. That yields assertable facts —
which image origins loaded, CSP violations, DOM counts, paint timing — and works
where screen capture does not.

**Verify against a window that is actually visible.** A window reporting
`document.hidden` gets no rendering lifecycle, which disables
`requestAnimationFrame`, `IntersectionObserver` and scroll events. Lazy rows
never load and scroll-driven UI never updates. Check `document.visibilityState`
before chasing it as an application bug.
