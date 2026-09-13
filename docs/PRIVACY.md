# Privacy Policy

**WatchThemAll** · Last updated: 13 September 2026

WatchThemAll is an open-source desktop and Android application with no backend.
There is no server operated by this project, no account to create, and no
analytics or telemetry of any kind.

## What is stored, and where

Your library — what you have watched, what you are part-way through, which
providers you enabled, and your settings — is stored **on your own device** as a
single JSON file. On desktop, Settings shows you exactly where; on Android it
lives in the app's private storage.

Nothing in that file is sent anywhere unless you turn on sync.

## Optional sync

If you connect a Google account, WatchThemAll asks for one permission:

> `https://www.googleapis.com/auth/drive.file` — "See, edit, create and delete
> only the specific Google Drive files you use with this app"

This grants access only to files the application itself creates, in practice one
file. Your other documents and photos are not merely off-limits; they are absent
from every listing the application can make.

With sync on:

- A copy of your library is written to `WatchThemAll library.json` in your own
  Drive, against your own storage quota. You can see it, move it and delete it
  like any other file.
- Your other devices read and write that same file, which is how they agree.
- **The data never passes through any system operated by this project.** Your
  device talks to Google directly. We do not host it, cannot read it, and never
  receive a copy.

Access and refresh tokens are stored on your device and transmitted only to
Google. On desktop they go in the operating system's credential store — Keychain,
libsecret or DPAPI. On Android they are kept in the app's private storage, the
same boundary as the library file itself.

**Turning it off:** disconnect the account in Settings, which deletes the stored
tokens. Revoke access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Delete `WatchThemAll library.json` from your Drive to remove the synced copy;
nothing else is left behind.

## Third parties the application contacts

**The Movie Database (TMDB)** is queried for titles, artwork, cast, episode lists
and air dates. These requests contain the search terms and title identifiers
needed to answer them. This product uses the TMDB API but is not endorsed or
certified by TMDB. See
[TMDB's privacy policy](https://www.themoviedb.org/privacy-policy).

**Intro-skip databases (optional, on by default).** When you start an episode,
the application asks up to three community databases where that episode's intro
is: [IntroDB](https://introdb.app/), [SkipDB](https://skipdb.tv/), and
[AniSkip](https://api.aniskip.com/) for anime. Each request contains the IMDB id
of the series and the season and episode number, so those services learn what you
are watching. Nothing else is sent: no account, no device identifier, no viewing
history, and no record of whether you pressed the button.

Three details change what this actually exposes:

- The lookup happens **after playback starts**, not when you open a title. A
  title you looked at and did not watch is never sent anywhere.
- It happens **once per episode**.
- For anime, a public id-mapping file is downloaded from GitHub and cached
  locally. That request says nothing about what you are watching.

Turning the feature off in the Providers panel stops all of these requests. There
is nothing stored to delete.

**Video embed providers** are third-party websites you choose to open from within
the application. Your device connects to them directly, exactly as a browser
would, and they see what any website you visit would see. WatchThemAll does not
host, stream or proxy any video and has no relationship with these sites. Their
own policies apply.

## What is never collected

No usage analytics. No crash reporting. No advertising identifiers. No profile of
what you watch is built anywhere except on your own device, to order your own
browse screen.

Nothing is sent to any third party not listed above. The intro-skip lookup is the
only one you can switch off, because it is the only one not required for the
application to do what you asked it to.

## Children

The application is not directed at children and collects no personal information
from anyone, including children.

## Changes

This policy is versioned in the project's public repository, so every change to
it is visible in the commit history.

## Contact

[github.com/UserError418/WatchThemAll/issues](https://github.com/UserError418/WatchThemAll/issues)
