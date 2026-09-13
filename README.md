<div align="center">

<img src="icons/icon128.png" width="88" alt="">

# WatchThemAll

**One place for everything you're watching.**

Browse, track and resume films and series across the embed providers you
configure — on your desktop and on your phone.

[![Download](https://img.shields.io/github/v/release/UserError418/WatchThemAll?label=download&style=for-the-badge&color=e8b04b)](https://github.com/UserError418/WatchThemAll/releases/latest)
[![License](https://img.shields.io/github/license/UserError418/WatchThemAll?style=for-the-badge)](LICENSE)
![Platforms](https://img.shields.io/badge/linux%20·%20windows%20·%20macos%20·%20android-informational?style=for-the-badge)

<img src="docs/screenshots/browse.jpg" width="820" alt="The Browse screen: a full-bleed hero over rows of cover art">

</div>

---

## What it does

Embed sites don't remember what you watched, don't tell you when the next
episode lands, and every one of them looks different. WatchThemAll sits on top
of whichever ones you point it at and keeps the part that matters — your
library.

- **A browse screen built from your own library.** The hero shows the most
  urgent thing *you* have going: a tracked series airing this week, or whatever
  you're part-way through. Genre rows are ordered by what you actually watch.
- **Resume exactly where you stopped** — the real position in the episode, not
  a guess, and it follows you when you switch to a different provider mid-show.
- **Know when the next episode airs.** Track a series and get a notification on
  the day, with a live countdown in the app.
- **Providers you control.** Turn them on and off, drag them into the order you
  want, and let Automatic pick — it learns which one actually worked for which
  show and leads with that.
- **Never see a dead stream twice.** If a source stalls, the app notices and
  moves to the next one on a five-second countdown you can cancel.
- **Skip the intro.** A button in the corner during the title sequence, from
  community-maintained timestamps — around 80% of what people actually watch
  has them, and rather more for anime. It appears only when the stream's own
  length agrees with what the episode should be, so a provider serving the
  wrong programme never gets to seek you into it. One switch turns the whole
  thing off, including the lookups; see [the privacy policy](docs/PRIVACY.md)
  for exactly what is sent.
- **The same library on every device.** Sign in the way you would sign a TV
  into YouTube — a short code, typed on a device you already use — and your
  desktop and your phone stay in step. There is no account with us and no
  server of ours involved.
- **Bring your history with you.** Import from MyAnimeList, or take your whole
  library out as one file whenever you want.

<img src="docs/screenshots/detail.jpg" width="820" alt="A series detail view with the season list and per-episode progress">

## Get it

**[Download the latest release →](https://github.com/UserError418/WatchThemAll/releases/latest)**

| | |
|---|---|
| **Linux** | `.AppImage` — make it executable and run it. Also `.deb`. |
| **Windows** | `.exe` installer. |
| **macOS** | `.dmg`. |
| **Android** | `.apk` — sideload it. See [`mobile/`](mobile/README.md). |

The Android app is the same app: the same screens, the same library, laid out
for a phone.

> **A note on the Android build.** It is signed with a debug key, which is fine
> for sideloading but means it cannot upgrade over an install from anywhere
> else — uninstall first if you have one.

## Notices

**WatchThemAll hosts, streams, proxies and distributes no video.** It builds
URLs for third-party sites, opens them in a window, and records what you
watched. No video content is stored in this repository or served by this
project.

**No affiliation, no endorsement.** This project has no relationship with any of
the sites it can be pointed at, and no control over what they serve, whether
they are licensed to serve it, or what else they put on the page. You can
disable any entry, reorder the list, or add your own.

**Metadata** and artwork come from [TMDB](https://www.themoviedb.org/). This
product uses the TMDB API but is not endorsed or certified by TMDB.

## How it works, briefly

Three pieces, and only the first one is unusual:

**Playback is an embed page inside the app.** Both apps put the provider in a
frame of their own and draw their controls over it. That is what lets the app
read the video's real position — resume, "watched" and stall detection all come
from that — and it is also the boundary at which pop-ups and unsolicited
navigation away from the page are denied.

**Everything else is one shared codebase.** The interface, the design system,
the provider logic and the store are written once and run in both apps. The
platform boundary is a single TypeScript interface, which is why the phone app
is a port rather than a rewrite.

**Your library is one JSON file on your own machine.** No account with us, no
server of ours, no telemetry. Export it, import it, or read it in a text editor.

If you turn on sync, that file is mirrored into a single file in **your own
Google Drive**. The app can only ever touch files it created itself — the rest
of your Drive is invisible to it — and you can delete the one it makes like any
other file. Your devices talk to Google directly; nothing passes through us,
and we could not read it if it did.

## Build it yourself

```bash
npm install
npm run dev            # desktop, with hot reload
npm run build:linux    # or :win / :mac
npm run apk            # the Android build (needs JDK 21 + Android SDK)
```

The Android build needs JDK 21 and the Android SDK. The provisioning script
that installs both is not published — see "What is not in this repository".

## Contributing

Issues and pull requests are welcome. Please don't open issues or PRs that add
new streaming sources; the provider list is not crowd-sourced.

Before opening a PR, `npm run lint`, `npm run typecheck` and `npm test` should
all pass. The provider catalogue is documented in
[`docs/PROVIDERS.md`](docs/PROVIDERS.md); what the app sends and stores is in
[`docs/PRIVACY.md`](docs/PRIVACY.md).

## What is not in this repository

Two things are maintained but deliberately unpublished, and the source refers
to them in passing:

- **`scripts/`** — the build, deploy, release and provisioning tooling, plus
  the development harness that drives a running app over the DevTools
  protocol. Some of it installs onto a named machine over SSH. The practical
  consequence is that **`npm run apk` will not work in a clone**, because it
  points at `scripts/build-apk.sh`. Every other script in `package.json` —
  `dev`, `build`, `lint`, `typecheck`, `test` — is self-contained and works.
- **The long-form design documents.** Comments in the source occasionally cite
  them by name. Treat those as a pointer to reasoning that is not public
  rather than to a file you are expected to find.

## Licence

[MIT](LICENSE).
