# Privacy Policy

**WatchThemAll**
Last updated: 12 September 2026

WatchThemAll is an open-source desktop and Android application. It has no
backend. There is no server operated by this project, no account to create with
us, and no analytics or telemetry of any kind.

This document describes what the application does with data, because that is
the only thing there is to describe.

## What is stored, and where

Your library — what you have watched, what you are part-way through, which
providers you have enabled, and your settings — is stored **on your own device**
as a single JSON file. On the desktop you can see exactly where by opening
Settings and looking at the data directory; on Android it lives in the app's
private storage.

Nothing in that file is sent anywhere unless you turn on sync.

## Optional sync, and what it does with your Google account

If you choose to connect a Google account, WatchThemAll asks for one permission
and only one:

> `https://www.googleapis.com/auth/drive.file` — "See, edit, create and delete
> only the specific Google Drive files you use with this app"

This grants access to **only the files the application itself creates** — in
practice, one file. It does **not** grant access to your other files, your
documents, your photos, or anything else in your Drive. Those are not merely
off-limits: they are absent from every listing the application can make. It
cannot see them and does not ask to.

With sync on:

- A copy of your library is written to a single file in your own Drive, named
  `WatchThemAll library.json`, counting against your own storage quota. You can
  see it, move it, and delete it like any other file of yours.
- Your other devices read and write that same file, which is how they end up
  agreeing.
- **The data never passes through any system operated by this project.** Your
  device talks to Google directly. We do not host it, cannot read it, and never
  receive a copy.

The access token and refresh token that make this possible are stored on your
device and are not transmitted anywhere except to Google. On desktop they go in
the operating system's credential store — Keychain, libsecret or DPAPI. On
Android they are kept in the app's private storage, which is the same place the
library file itself lives; on an unrooted device that is the boundary.

### Turning it off, and deleting the data

- **In the app:** disconnect the account in Settings. This deletes the stored
  tokens from your device.
- **In your Google account:** revoke access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **To delete the synced copy:** delete `WatchThemAll library.json` from your
  Drive. It is an ordinary file of yours; nothing else is left behind.

## Third parties the application contacts

**The Movie Database (TMDB)** is queried for titles, artwork, cast, episode
lists and air dates. These requests contain the search terms and title
identifiers needed to answer them. This product uses the TMDB API but is not
endorsed or certified by TMDB. See
[TMDB's privacy policy](https://www.themoviedb.org/privacy-policy).

**Intro-skip databases (optional, and switchable).** If "Offer to skip intros"
is on — it is on by default — then when you start an episode the application
asks up to three community databases where that episode's intro is:
[IntroDB](https://introdb.app/), [SkipDB](https://skipdb.tv/), and
[AniSkip](https://api.aniskip.com/) for anime. Each request contains the IMDB
id of the series and the season and episode number, so those services learn
what you are watching. Nothing else is sent: no account, no device identifier,
no viewing history, and no record of whether you pressed the button.

Three details worth knowing, because they change what is actually exposed:

- The lookup happens **after playback starts**, not when you open a title. A
  title you looked at and did not watch is never sent anywhere.
- It happens **once per episode**, not repeatedly.
- For anime, a public id-mapping file is downloaded from GitHub and cached on
  your device. That request says nothing about what you are watching.

Turn it off in the Providers panel and none of these requests are made.
Existing data is unaffected; there is nothing stored to delete.

**Video embed providers** are third-party websites that you choose to open from
within the application. When you play something, your device connects to that
provider directly, exactly as a browser would, and that provider sees what any
website you visit would see. WatchThemAll does not host, stream or proxy any
video, and it has no relationship with these sites. Their own policies apply
and this project has no control over them.

## What is never collected

No usage analytics. No crash reporting. No advertising identifiers. No profile
of what you watch is built anywhere except on your own device, for the purpose
of ordering your own browse screen.

Nothing is sent to any third party that is not listed above, and the only one
of them you can switch off is the intro-skip lookup — because it is the only
one that is not required for the application to do what you asked it to.

## Children

The application is not directed at children and collects no personal
information from anyone, including children.

## Changes

This policy is versioned in the project's public repository, so every change to
it is visible in the commit history.

## Contact

Questions or concerns:
[github.com/UserError418/WatchThemAll/issues](https://github.com/UserError418/WatchThemAll/issues)
