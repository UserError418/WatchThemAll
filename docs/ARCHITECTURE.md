# WatchThemAll — architecture

Written 2026-09-06, at the start of the rewrite. This is the design the code is
being moved *to*. Where the code and this document disagree, the code is either
not there yet or this document is stale — say which in the commit that fixes it.

## What this app is

A desktop client for watching TV and film through third-party embed providers.
It does not host or stream anything itself: it builds provider URLs, opens them
in a player window, and keeps track of what you watched and what is coming out.

The value is entirely in the layers *around* the embed: knowing what exists,
what is worth watching, where you left off, and when the next episode lands.

## Why this is a rewrite and not a refactor

The original was generated in one pass by a weaker model and ported from a
Chrome extension without unwinding the extension's assumptions. Three things in
it are not fixable in place:

- **`src/app-ui.js` is a 3189-line class holding all state and all DOM.** It
  renders by concatenating HTML strings and re-attaching every listener on every
  change. The recommendation dashboard builds up to 700 tiles in one string.
  There is no seam to refactor along — the state, the fetch, and the markup are
  the same statements.
- **The renderer still thinks it is a browser extension.** `storage.js` calls
  `chrome.storage.local`, which only resolves because `app.html` aliases a
  preload shim onto `window.chrome`. The renderer also makes its own network
  calls, which is why the app needs `webSecurity: false`.
- **Metadata comes from TVmaze**, which serves 210×295 portraits and nothing
  else. A browse UI built on cover art cannot be built on that source.

So the renderer, the data layer, and the discovery engine are all replaced. What
survives is `main.js`'s window/tray/menu/store skeleton, the provider URL
template model, and the accumulated knowledge of which providers work.

## Processes

Standard Electron three-target split, built by `electron-vite`.

```
src/main/        Node. Windows, menu, tray, store, TMDB client, IPC handlers.
src/preload/     The only bridge. Exposes a typed, enumerated API surface.
src/renderer/    Svelte 5 + TypeScript. No Node, no direct network access.
src/shared/      Types and the IPC channel contract, imported by all three.
```

**The renderer makes no network requests.** Every TMDB call goes through the
main process, which owns the API key, the cache, and the rate limiting. This is
what lets us turn `webSecurity` back on for the main window: the renderer only
ever loads local files and TMDB image URLs.

Player windows are a separate matter — they load untrusted third-party pages and
keep `webSecurity: false` because video CDNs are cross-origin from the embed
page. They are isolated: no Node, context isolation on, all popups denied, and
the preload there talks over a single narrow channel.

## Data sources

**TMDB is the only metadata source.** Verified 2026-09-06 as covering everything
the app needs:

| Need | Endpoint |
|------|----------|
| Browse rows | `trending/*`, `tv/top_rated`, `tv/on_the_air`, `discover/tv` |
| Search | `search/multi` |
| Show + season detail | `tv/{id}`, `tv/{id}/season/{n}` |
| Release countdown | `next_episode_to_air` on `tv/{id}` |
| Provider URL building | `tv/{id}/external_ids` → `imdb_id` |
| Artwork | `backdrop_path`, `poster_path`, `still_path` |

TVmaze is retired. It was a second source of truth for the same facts, with
worse artwork and no popularity signal.

**API key.** The repo currently carries a public key that has been shared around
the internet for years. It works today, and it is a liability: it is in a public
repo and it is rate-limited across every project using it. Replace it with a
personal key injected at build time via `VITE_TMDB_KEY`, and keep the public one
only as a development fallback.

## Storage

One JSON file, as before, at `{userData}/data/watchthemall.json`, written
atomically through a temp file and rename.

Two changes from the original. Writes are **debounced and coalesced** — the old
code rewrote the whole file synchronously on every `storage:set`, which cost 20
full-file writes before the first paint. And the store is **namespaced and
typed** rather than a flat bag of `vidsrc_*` keys inherited from the extension.

SQLite was considered and rejected: the data is a few hundred records, and
`better-sqlite3` is a native module that complicates every `electron-builder`
target for no benefit at this size.

The export/import format stays byte-compatible with the Android app and the
ReelVault extension. That cross-app sync is a real feature and breaking it
silently would be the worst kind of regression.

## Information architecture

Four surfaces, matching how the app is actually used.

- **Browse** — the default view. Full-bleed hero backdrop, then horizontally
  scrolling rows: Trending, Because You Like *(top genre)*, Top Rated, New &
  Upcoming, and per-genre rows. Rows load lazily as they enter the viewport;
  tiles inside a row page in as it scrolls.
- **Search** — TMDB multi-search, results as a card grid.
- **Watchlist** — what you are actually watching, with resume position, plus the
  History timeline of everything played.
- **Releases** — series you have asked to be told about. Countdown to the next
  episode or season, and an OS notification when one lands.

The old app split this as Bookmarks / Watchlist / History with the sidebar as
the primary surface. The concepts survive under clearer names: old *Bookmarks*
became **Watchlist**, old *Watchlist* became **Releases**.

## Rendering

Svelte 5, chosen over React because the failure mode being escaped is
re-render cost on large lists, and Svelte compiles to direct DOM updates rather
than diffing a virtual tree. A row of 100 poster tiles should not be a
performance decision the developer has to remember to make.

Two rules that exist because the original violated both:

- **No `innerHTML` and no string-built markup.** Components take data.
- **Long lists are windowed.** A browse row renders the tiles in view plus a
  small buffer, not all 100.

## Removed

The **HLS downloader** is gone, by decision on 2026-09-06. It opened a hidden
browser window, sniffed `.m3u8` requests, required the user to manually click
play, downloaded segments in parallel and concatenated them into a raw `.ts`
file. Its quality picker was wired to two IPC channels that had no handler in
the main process, so it never worked. It was the most fragile subsystem in the
app and the most exposed to providers changing their delivery.

## Hard-won constraints

Things that are not obvious from the code and that a future change will break
if it does not know them.

**Reactive state cannot cross the IPC boundary.** Svelte 5 `$state` values are
Proxies, and `structuredClone` — which is what `contextBridge` and
`ipcRenderer.invoke` use — throws `An object could not be cloned` on one. Every
write must go through `$state.snapshot()` first. This failed silently in
development: the optimistic UI update had already happened, so the app looked
completely healthy until it was restarted and the changes were gone. That is
why `library.persistError` exists and is rendered as a banner rather than only
logged.

**Seasons and episodes are 1-based everywhere.** A zero means a caller failed
to parse something. `setPosition` and `setWatched` reject non-positive values,
and `migrate` repairs stored positions that already hold one — the original
wrote `S00E00` over real positions whenever its player preload could not parse
an episode from a path-style provider URL.

**"Not worth saving" and "forget what you saved" are different answers.** The
resume point is written from a position read off the provider's own `<video>`,
and plenty of providers nest that element somewhere unreachable — so the routine
outcome of a poll is *no reading at all*. Collapsing that into the same branch
as "watched to the end" is what made resuming look random across sources: a
provider with no reachable element did not merely fail to save a position, it
deleted the one a working provider had stored, and switching back found nothing.
`resumeAction` in `resume.ts` returns three values for that reason, and `keep`
is the default. Forgetting requires positive evidence the title is finished.

**Navigating within a title is not leaving it.** A provider switch, a reload and
a crash fallback all stay on the same episode, so none of them should settle
progress: `settleProgress` decides "watched" and drains the elapsed-time
counter, and that counter is the *only* progress signal for a provider with no
reachable `<video>`. Draining it on every switch split one episode into three
stretches, none of them long enough to count. Settling belongs to `closePlayer`
and to `navigatePlayer`, the two places where the title actually changes.

**A disabled provider is never a fallback.** An earlier version of the play
handler appended disabled providers after the enabled ones as a last resort,
which meant a provider switched off deliberately could still be opened. If
nothing enabled can serve a title, that is an error with a reason, not a cue to
try something else.

**The player window is told what it is showing.** It does not read its own URL.
The main process knows which template built that URL and sends the context over
`EV.playerContext`; navigation goes back the other way over `EV.playerNavigate`
and is rebuilt from the same template. The original guessed with three fallback
heuristics and mis-detected episodes whenever a path contained other digits.

**A cross-origin iframe hides the pointer from the view that contains it.**
`webContents.on('input-event')` was believed to be a stream no frame could
suppress; it is not. Chromium hit-tests the first move and then routes pointer
events straight to the target widget, and on a playing embed the target is the
provider's own out-of-process iframe. Measured: dragging the pointer from the
middle of the picture to the top edge produced exactly one report — the
position where it entered the view — and then nothing. The player chrome hung
off that signal and was therefore never summoned once, on any provider, with
nothing in any log to say why. It is now summoned by a live strip the overlay
keeps along the top edge (`HOT_ZONE_PX`), which needs no cooperation from the
page at all.

**Detaching a `WebContentsView` does not close it.** `removeChildView` takes it
out of the window's tree and leaves the web contents running in its own
renderer process. Three players opened in one session left three live
`chrome.html` targets in the debugger. Teardown has to call
`view.webContents.close()`.

**Anything drawn in the app window is *under* the video, so it must not be a
dialog.** The window's own page always paints beneath its child views, which is
why the player chrome, the source list and the failed-source banner all live in
a second transparent `WebContentsView` stacked above the player. The banner was
the last holdout: rendered in the app window it could only make itself visible
by reserving a band of layout, and that reservation is what pushed the picture
down every time a provider failed. The matching obligation is that the overlay
**swallows every mouse event inside its bounds**, so it reports its own
measured height to main and is sized to exactly what it draws.

**`electron-vite` 5 does not support Vite 8**, and
`@sveltejs/vite-plugin-svelte` 7 requires it. The working combination is Vite 7
with plugin-svelte 6. Do not resolve the conflict with `--legacy-peer-deps`.

**The renderer's Vite root is `src/renderer`**, so `build.outDir` must be an
absolute path or the bundle lands in `src/renderer/out` and gets linted as
source.

## Testing

Vitest, replacing the `node:vm` sandbox harness that existed only because the
renderer files were globals in script tags.

The original's 25 tests covered the data models, the URL template parser, and
the JSON store — all worth keeping, and they port directly. The gap to close is
everything else: the TMDB client, the store's merge and migration logic, and the
provider URL builder against real provider templates.

Priority is the code where being wrong is silent: the store migration, the
export/import merge, and the URL template substitution. All three are covered,
and each suite exists because that code shipped a defect once.

The UI is verified against the running app over the Chrome DevTools Protocol
rather than by screenshot — launch with `--remote-debugging-port`, then
`Runtime.evaluate` against the renderer target via `scripts/cdp.py`. That yields
assertable facts (which image origins actually loaded, CSP violations, DOM
counts, paint timing) instead of a picture somebody has to interpret, and it
works in environments where screen capture does not.

**Verify against a window that is actually visible.** A window reporting
`document.hidden` gets no rendering lifecycle, which silently disables
`requestAnimationFrame`, `IntersectionObserver` and scroll events — so lazy rows
never load and scroll-driven UI never updates. Chasing that as an application
bug is wasted effort; check `document.visibilityState` first.
