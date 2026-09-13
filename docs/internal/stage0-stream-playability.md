# Stage 0: can a provider's stream be played outside the browser?

Measured 2026-09-13. This is the gating experiment for the live-upscaler plan,
and for anything else that needs the app to own its own `<video>` — resume to an
exact position, stall detection, the auto-switch countdown.

**The question.** Every provider is an embed *page*. The video decodes inside a
cross-origin document in a `WebContentsView`, and the app never touches a frame.
An upscaler needs frames. So either the app extracts the manifest and plays it
itself, or the feature does not exist. Whether that extraction is possible is a
question about third parties, not about our code.

**The method.** `npm run probe:streams` loads each provider's embed page in a
real browser, presses play, captures the first media URL with the headers
Chromium sent, and re-fetches it. Then `scripts/probe-playback.py` hands that URL
to **mpv** — the player the app would actually embed — and counts the PNG frames
that come out. Subject: Fight Club (tmdb 550), runtime 139 minutes.

Frames on disk are the evidence. Everything cheaper lies, and three of the four
cheaper checks lied during this run.

## Results

All 15 catalogue providers. `plays` means mpv decoded real frames *and* the
manifest ran feature-length.

| Provider | Tier | Extract | Playback | Detail |
|---|---|---|---|---|
| **VidFlix** | core | header-gated | **plays** | 1280x528, 8348.4 s |
| **VidSrc** | core | open | **plays** | 1920x800, 8348.4 s |
| **VidZee** | core | header-gated | **plays** | 1920x800, 8348.2 s |
| VidLux | core | open | broken | manifest correct (8348.3 s, 360p) — segment proxy refuses the player |
| CinemaOS | core | sealed | broken | DASH, 415 bare and replayed |
| VidRock | core | open | forbidden | decoy URL; 403 on re-request |
| VidFast | core | none | no-stream | no media URL captured — see limits |
| Videasy | core | none | no-stream | no media URL captured — see limits |
| ScreenScape, MoviesAPI, SuperEmbed, VidSrc PM, VidCore, 111Movies | extras | none | no-stream | |
| VidSrc (.su mirror) | extras | — | forbidden | 401 |

**3 of 8 core providers play. 3 of 15 overall.**

8348 seconds is 2 h 19 m — Fight Club's exact runtime. All three are the whole
film at its real resolution, not a trailer, a slate or a preview.

## What this cost to measure, and why the number moved twice

Three defects in the measurement tooling, each of which changed the answer:

1. **`--extract-streams` exited after the first provider.** It destroys its
   hidden window between subjects, which fires `window-all-closed` →
   `app.quit()`. The process exited **zero** having written one result. A silent
   partial run that reports success is the worst shape a measurement failure can
   take.
2. **The extractor never pressed play.** `streamprobe` clicks at 2.5 s and 6 s
   because these players draw their own overlay and resolve nothing until it is
   clicked; `streamextract` was written without that step. Four of eight core
   providers reported "no stream at all" because of it. **VidLux and VidSrc both
   went from `none` to a working `open` HLS the moment it was fixed** — same
   provider, same title, same minute. The bias was against building the feature.
3. **`segment:ok` and `segment:FAIL` are both unreliable.** VidFlix reports
   `segment:FAIL` and plays perfectly in mpv; VidRock reports `open` with a
   clean 200 and is serving `vidrock.net/demo-video.mp4`, a placeholder. Only
   the player and the duration tell the truth.

## Known limits of this measurement

- **VidFast and Videasy are unmeasured, not refused.** Both return no media URL
  to the probe's synthetic click. VidFast demonstrably streams — it was watched
  end to end on an Android emulator the same day — so its overlay wants a real
  input event the probe does not produce. Two of the catalogue's best providers
  are therefore absent from the table, and the answer changes materially if they
  work.
- **One subject, one title.** Coverage is per-episode; a provider that serves
  Fight Club may not serve a given show.
- **Headless, software rendering.** Attempts to run against the real GPU display
  failed on X authorisation and fell back to software. Results were identical
  across both software runs, so this is unlikely to matter, but it is untested.
- **VidLux is a throughput and request-shape problem, not an access problem.**
  Its segments fetch with curl — 200, 6.9 MB — but take 17.9 s for 13 s of 360p
  video, and its proxy rejects mpv's request even at a 120 s timeout.

## Verdict

Below the kill criterion of "about half the core providers", but not cleanly,
and the cheapest remaining work is also the most decisive: make the probe press
play the way a person does, and measure VidFast and Videasy. Until then the
honest count is **3 measured working, 2 unmeasured, 3 refusing**.

Reproduce:

```bash
npm run probe:streams -- --only <ids> --json /tmp/extract.json --timeout 30000
scripts/probe-playback.py /tmp/extract.json --json /tmp/playback.json
```
