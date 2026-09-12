# Cycle 2 — from prototype to product

The first cycle rebuilt the app on Svelte 5 with a typed IPC contract and a
Netflix-shaped layout. It shipped as a working prototype with four real
problems, three of which were regressions introduced by the rewrite itself.

This document is the plan for closing them. It exists so the *reasoning* behind
the sequencing survives — the code will show what was done, not why this order.

## What cycle 1 got wrong

Recorded plainly, because each one is a lesson about the rewrite, not just a bug.

### 1. Provider selection was built as dead code

`Library.setDefaultProvider()` exists and **nothing ever calls it**. So
`settings.defaultProviderId` is permanently `null`, `buildPlayUrl` receives no
preferred provider, and playback always falls through to the first enabled
provider in catalog order. The user cannot influence it at all.

`ProviderPanel` looks like the answer but is not: it toggles and reorders the
global set. There is no per-title choice and no way to switch after a provider
fails.

The lesson: a state method with no caller is not a feature. The typed IPC
contract catches an unhandled *channel*, but nothing catches an unreferenced
*method* — that needs a test or a lint rule, and now has one.

### 2. Playback picks a provider without ever checking it works

`buildPlayUrl` returns the first provider whose **template renders**. Rendering
proves the URL is well-formed, nothing more. The original probed provider
reachability (`legacy/src/app-ui.js:600`); the rewrite dropped it, so a dead
provider is chosen silently and the user gets a blank player and no reason.

### 3. Browser identity simulation was dropped

The original set a Chrome User-Agent on the default session and **replaced**
`Sec-CH-UA` client hints with matching Chrome values
(`legacy/main.js:39-68`). Its comment is the important part:

> Real Chrome always sends Sec-CH-UA — missing headers are MORE suspicious than
> Electron-branded ones.

The rewrite sends Electron's own UA, which contains the literal string
`Electron/42.5.0`. Restoring this is not optional; embed providers key on it.

### 4. IMDB search was retired, and it was load-bearing

The original used IMDB's suggestion endpoint
(`https://v3.sg.media-imdb.com/suggestion/x/<query>.json`) for general search.
Cycle 1 replaced it with TMDB search on the reasoning that one metadata source
is simpler than two. That reasoning was wrong for a specific reason:

**Providers key on IMDB ids.** The IMDB endpoint returns the id we actually
need, directly, for essentially every title that exists. TMDB search returns a
TMDB id and then needs a second `external_ids` round trip — and where TMDB has
no `imdb_id`, the title becomes unplayable rather than merely slower.

So the two backends had distinct jobs and both were needed:

| Backend | Job |
|---|---|
| IMDB suggestion | general search; the authoritative IMDB id; breadth of catalogue |
| TMDB | artwork, episode lists, air dates, the release countdowns |

## Sequencing

Backends and provider control come before the visual work. Both because the
visual work is pointless on an app that cannot play anything, and because it
means there is something testable early rather than at the end.

### Phase 1 — Backends

- `main/imdb.ts` — suggestion-API client, mapped into `MediaSummary`
- `main/identity.ts` — session UA, `Sec-CH-UA` rewriting, per-provider
  `Referer`/`Origin`
- `main/health.ts` — provider reachability probing, cached, surfaced to the UI
- TMDB `/find` bridge (IMDB id → TMDB id) and `/videos` (trailer keys)
- IPC contract extended for all of the above

### Phase 2 — Provider control

- Per-title provider picker in the detail overlay
- In-player provider switching, without closing the window
- Automatic fallback when a provider fails, with the reason shown
- Catalog audit against live probes; fix templates that no longer resolve

### Phase 3 — The Netflix layer

Agreed scope: Netflix's layout, spacing, type scale, card physics and motion
curves, with our own accent colour rather than Netflix red.

- Billboard hero with muted trailer autoplay, falling back to artwork
- Card hover previews — scale, then trailer after a delay
- Top 10 row with the oversized numerals
- Netflix-style detail modal: large backdrop, episode selector, More Like This
- Motion, focus states, skeletons, typography pass

### Phase 4 — Verification

Reproduce the reported provider failure in-app with devtools rather than
inferring it from the shell, then the full gate run and a visual pass over every
surface under Xvfb.

## Constraints that do not change

- The renderer makes **no** network requests. Everything goes through main.
  This is what allows `webSecurity: true` on the app window.
- Trailer playback is the one new network surface in the renderer, and it gets a
  narrowed CSP exception for the YouTube no-cookie origin only.
- The export format stays frozen — it is shared with the Android app and the
  ReelVault extension.
