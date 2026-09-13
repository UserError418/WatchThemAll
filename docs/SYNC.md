# Cross-device sync

The requirement: signing in must be as simple as signing into YouTube on two
devices, it must work without fuss, and WatchThemAll must host no user's files
anywhere. The last clause rules out an account system with a server behind it.

## How it works

Open Settings → Sync and the app shows a short code. Type it at
`google.com/device` on any phone or laptop and approve. Do the same on the other
device. Both now hold the same library.

That is the [OAuth 2.0 device
flow](https://developers.google.com/identity/protocols/oauth2/limited-input-device),
using Google's own client type for TVs and limited-input devices — the same
mechanism behind signing a TV into YouTube.

The library goes into the user's **own Google Drive** as a single file under the
`drive.file` scope. The app can only touch files it created itself; everything
else is absent from any listing it can make. This project stores nothing, hosts
nothing, and cannot read it.

Three properties follow from the device flow, and they are the reason it was
chosen over anything else:

- **`drive.file` is a non-sensitive scope**, so the app is not bound to Google's
  verification process and there is no 100-user cap. Adding any other scope,
  including `userinfo.email`, reinstates both.
- **There is no redirect**, so there is nothing for an Android WebView to block.
  Desktop and Android run identical sign-in code with no platform branch.
- **No APK signing fingerprint is registered anywhere.** Google's Android OAuth
  client type binds to a package name plus a SHA-1, which would break every fork
  and self-built APK. This flow binds to neither.

The synced file is visible to the user rather than hidden in an app-data folder.
`drive.appdata` and `drive.appfolder` are both rejected by the device-flow
endpoint with `invalid_scope`, and `drive` is rejected as restricted. A file the
user can find is one they can delete without taking anyone's word for it.

## What makes a merge possible

`src/shared/store` carries three things that cannot be added retroactively
without inventing data:

- **`updatedAt` on every record** — which of two edits is newer.
- **`deletedAt`, a tombstone.** A record merely absent from one side is
  indistinguishable from one that side has not seen. Without tombstones, a merge
  resurrects every deletion, forever.
- **`preferenceUpdatedAt`.** Scalar settings have no per-record identity, so they
  are stamped per key. Otherwise one toggle wins or loses the whole block.

Plus a `deviceId` per install, so a sync can tell its own writes from a peer's.

## The merge

| Field | Rule |
|---|---|
| `watchlist` | Union by `id`. Episodes carry one stamp each (`episodeMarks`) and are decided individually, which is what lets an episode be un-marked without another device putting it back. `lastSeason`/`lastEpisode` are a cursor and go to whoever moved them last. |
| `trackers` | Union by `id`. `lastNotified` takes the later episode; `nextEpisode` comes from the side with the newer `lastChecked`. |
| `history`, `watched`, `ratings` | Union by identity, newer `updatedAt` wins. Effectively append-only. |
| `resumePoints` | Newer `updatedAt` wins. Keyed by `tmdbId:season:episode`, so two devices watching different episodes never collide. |
| `streamOutcomes` | Union, then the existing prune. Evidence from both devices beats evidence from one. |
| `customProviders` | Union by `id`. |
| preferences | Last write wins per key, on `preferenceUpdatedAt`. |
| tombstones | A deletion beats an older edit and loses to a newer one. |

Two rules deserve their reasoning spelled out, because the obvious version of
each is wrong:

**`watchedEpisodes` is not a set union.** A union can only grow, so un-marking
an episode is undone by the next sync with any device that still has it marked.
Taking the newer record's whole set instead is not the fix either — it cannot
distinguish *removed this* from *never saw this*, and drops an episode marked on
the other device while both were offline. Only a stamp per episode settles both.

**The playback position is a cursor, not a high-water mark.** Taking whichever
side is further along sounds protective and means a series can never be started
again. The device that moved it last wins.

Conflicts need no UI. Every rule above is one a user would agree with if asked,
and the honest place for a note is a plain "last synced" line.

**Lost updates are handled by the transport.** Drive returns an ETag; the app
pulls, merges, and pushes with `If-Match`. A `412` means a peer wrote in between,
so it pulls and merges again. The merge is idempotent and commutative, so the
retry is safe.

## Not encrypting the payload

The file is already private to one user and one app, and a passphrase that must
match on both devices is exactly the friction the requirement rules out. If a
backend ever lands where the host *can* read the file, encryption comes with it.

## Other backends

`SyncBackend` is two methods — pull the document, push it with an ETag — so
alternatives are cheap:

- **Microsoft OneDrive**, `Files.ReadWrite.AppFolder`. The same shape as Drive,
  also supports a device code flow, and consumer accounts have no verification
  requirement at all. It does offer the hidden app folder Google's device flow
  refuses. The best second backend.
- **A plain HTTP file store** (WebDAV, S3-compatible, Nextcloud, a NAS). Needs
  no vendor's cooperation and no app registration, which makes it the right
  escape hatch. It asks the user for a URL and credentials, so it cannot be the
  default.
- **A folder Syncthing or Dropbox already watches.** One settings field on
  desktop; on Android it needs the Storage Access Framework.

## Where the file export fits

Sync, not export, is now the way to move a library between your own devices. The
export stays for two narrower jobs: a backup you control, and interoperability
with the ReelVault extension, whose format it is. It is frozen and covers five of
fifteen fields. See [ARCHITECTURE.md](ARCHITECTURE.md#storage).

## Running your own client

Create one OAuth client in the Google Cloud Console: type *TVs and Limited Input
devices*, consent screen set to **Production**, and `drive.file` as the only
scope. No review, no fee, no waiting.

Production rather than Testing matters. In Testing, refresh tokens
[expire after seven days](https://developers.google.com/identity/protocols/oauth2)
and sync silently stops working every week.

The two values go in an untracked `.env`; `.env.example` has the walkthrough.
They are not committed — not for confidentiality, since the secret is extractable
from any released binary and Google's documentation assumes as much for this
flow, but because GitHub scans public repositories for this pattern with Google
as a scanning partner, and an automatic revocation would break sync for every
user at once.

A build with no `.env` compiles and runs, and says in Settings that sync is
unavailable in this build and why.

## Sources

[Device flow](https://developers.google.com/identity/protocols/oauth2/limited-input-device) ·
[Drive scope tiers](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) ·
[When verification is required](https://support.google.com/cloud/answer/13463073) ·
[Unverified apps and the 100-user cap](https://support.google.com/cloud/answer/7454865) ·
[Refresh token expiry](https://developers.google.com/identity/protocols/oauth2)
