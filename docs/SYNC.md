# Cross-device sync — design

Status: **built and shipping in 1.4.0.**

The requirement, and it is a hard one:

> Signing in must be as simple as signing into YouTube on two devices, it must
> work seamlessly, and WatchThemAll must host no user's files anywhere.

That last clause rules out the obvious shape — an account system with a server
behind it — and the first two rule out most of what is left. What survives is
one design, and it turns out to be the one the requirement was describing
literally.

## The answer: the same flow YouTube uses on a TV

Open WatchThemAll on the desktop, go to Settings → Sync, and it shows a short
code. Open `google.com/device` on any phone or laptop, type the code, approve.
Done. Do the same on the phone app. Both devices now hold the same library.

That is the [OAuth 2.0 device
flow](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
— the *exact* mechanism behind signing a TV into YouTube, using Google's own
client type for it ("TVs and Limited Input devices"). Not a lookalike.

The library itself goes into the user's **own Google Drive**, as a single file
under the `drive.file` scope: the app can only ever touch files it created
itself, and the rest of their Drive is invisible to it — absent from every
listing it can make, not merely off-limits. We store nothing, host nothing, and
cannot read it.

The file is visible to the user, which was not the first plan. `drive.appdata`
would have hidden it, Google's documentation for this flow lists that scope as
permitted, and **the endpoint rejects it**:

    scope=...auth/drive.appdata
    -> {"error":"invalid_scope","error_description":"Invalid device flow scope"}

Measured against a real client of that type, together with `drive.appfolder`
(rejected the same way) and `drive` (rejected as restricted). `drive.file` is
accepted and is classified non-sensitive just as `drive.appdata` is, so nothing
about the verification argument changes — only the visibility. Arguably for the
better: a file the user can find is one they can delete without taking our word
for it.

## Why this survives being a public project when nothing else did

An earlier revision of this document rejected Google. That rejection was wrong
on the two points that decided it, and the correction is worth stating plainly
because it inverts the conclusion.

**"An unverified app is capped at 100 users forever."** True, but only for apps
requesting *sensitive or restricted* scopes — the cap is attached to the
unverified-app warning screen, and that screen only appears for those tiers.
`drive.file` is classified
[**non-sensitive**](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
and Google states that an app using only non-sensitive scopes ["is not mandatory
… to complete the app verification
process"](https://support.google.com/cloud/answer/13463073). No warning screen,
no cap, no security assessment, no annual fee.

**"Android has no redirect left."** Also true, and completely irrelevant here:
**the device flow has no redirect at all.** There is nothing for an embedded
WebView to block, because no browser opens inside the app. Two consequences
follow, and the second is the one that matters most for an open project:

- The desktop app and the Android app run *identical* sign-in code. No
  Play-services plugin, no native module, no platform branch.
- **No APK signing fingerprint is registered anywhere.** Google's Android OAuth
  client type binds to a package name plus a SHA-1, which would break every
  fork and every self-built APK. The device flow binds to neither.

The remaining detail is the client secret, which has to ship in this repository.
That is not a leak, it is the documented condition of the flow: Google's own
page says "since the applications that use this flow are distributed to
individual devices, it is assumed that the apps cannot keep secrets." A fork
that would rather not share ours can paste its own two values into Settings.

One operational note: the OAuth consent screen must be set to **Production**, not
Testing. In Testing, refresh tokens
[expire after seven days](https://developers.google.com/identity/protocols/oauth2)
and sync would silently stop working every week. Moving to Production is a
self-service switch here precisely because no verification is required.

## What is already in place

`src/shared/store` carries the three things a merge cannot be built without, and
none of them can be added afterwards without inventing data:

- **`updatedAt` on every record.** Which of two edits is newer.
- **`deletedAt` — a tombstone.** A record merely *absent* from one side is
  indistinguishable from one that side has not seen yet. Without tombstones, a
  merge resurrects every deletion, forever.
- **`preferenceUpdatedAt`.** Scalar settings have no per-record identity, so
  they are stamped by key. Otherwise one toggle wins or loses the whole block.

Plus a `deviceId` per install, so a sync can tell its own writes from a peer's.

## The merge

Almost everything merges cleanly, which is a property of this particular
document rather than luck. A CRDT would be overkill.

| Field | Rule |
|---|---|
| `watchlist` | Union by `id`. Episodes carry **one stamp each** (`episodeMarks`) and are decided individually, which is what lets an episode be un-marked without another device putting it back. `lastSeason`/`lastEpisode` are a cursor and go to whoever moved them last. |
| `trackers` | Union by `id`; `lastNotified` takes the later episode, `nextEpisode` comes from the side with the newer `lastChecked`. |
| `history`, `watched`, `ratings` | Union by identity, newer `updatedAt` wins. Effectively append-only. |
| `resumePoints` | Newer `updatedAt` wins. Keyed by `tmdbId:season:episode`, so two devices watching different episodes never collide. |
| `streamOutcomes` | Union, then the existing prune. Evidence from both devices is strictly better than from one. |
| `customProviders` | Union by `id`. |
| preferences | Last write wins **per key**, on `preferenceUpdatedAt`. |
| tombstones | A deletion beats an edit older than it, and loses to one newer. |

Conflicts need no UI. Every rule above is one a user would agree with if asked,
and the honest place for a note is a plain "last synced" line, not a dialog
nobody can answer.

**Lost updates are handled by the transport, not the merge.** Drive returns an
ETag on the file; the app pulls, merges, and pushes with `If-Match`. A `412`
means a peer wrote in between, so it pulls and merges again. The merge is
idempotent and commutative, so the retry is safe.

## Not encrypting the payload, on purpose

The tempting extra is a passphrase and an encrypted blob. It is the wrong call
here: the file is already private to one user and one app, and a
passphrase that must match on both devices is precisely the friction the
requirement rules out — "as easy as signing into YouTube" does not include
"…and now transcribe a key." If a backend ever lands where the host *can* read
the file, encryption comes with it and not before.

## Other backends, and why they are second

The `SyncBackend` interface is two methods — pull the document, push it with an
ETag — so alternatives are cheap. They are still alternatives:

- **Microsoft OneDrive**, `Files.ReadWrite.AppFolder`. Worth noting it *does*
  offer the hidden app folder that Google's device flow refuses. The same shape as Drive,
  also supports a device code flow, and consumer Microsoft accounts have no
  verification requirement at all. The best second backend.
- **A plain HTTP file store** (WebDAV, S3-compatible, Nextcloud, a NAS). Needs
  no vendor's cooperation and no app registration, which makes it the right
  escape hatch — but it asks the user for a URL and credentials, so it can never
  be the default under this requirement.
- **A folder that Syncthing or Dropbox already watches.** One settings field on
  desktop; on Android it needs the Storage Access Framework, so it lands late or
  never.

## Where the file export fits after this

Once sync works, the export is no longer the way to move a library between your
own devices — sync is. It stays for two narrower jobs: a backup you control, and
interoperability with the ReelVault extension, whose format it is.

Worth being precise about that format, because it is easy to assume the store
rewrite changed it. It did not. `src/shared/store` is the app's *internal*
document, and it is now complete and mergeable. `src/main/sync.ts` is the
*interchange* format — frozen, shared with a third-party extension, covering
five of fifteen fields, and still setting `watchedEpisodes: []` on import. Both
statements are true at once, and neither is a bug: the export cannot grow fields
the extension does not understand, which is exactly why it makes a poor sync
basis and a fine interop one.

## What was built, in the order it was built

1. **`mergeDocuments`** — `src/shared/store/merge.ts`. First, because this is
   where a mistake silently eats a library. The properties earned their keep
   immediately: they found that sorting `watchedEpisodes` made the merge
   non-idempotent, so every sync rewrote the file to say the same thing, and
   they forced the precondition that a document holds each identity once to be
   stated rather than assumed.
2. **The device flow** — `src/shared/sync/devicecode.ts`. Plain `fetch`, no
   platform code, run unchanged by both apps. Its interesting branches cannot be
   produced against the real endpoint — you cannot ask Google for a `slow_down`,
   and waiting out an expired code takes half an hour — so the fetch, the clock
   and the sleep are injected and every branch is driven directly.
3. **The Drive backend** — `src/shared/sync/drive.ts`. List, download, upload,
   and nothing else, so a second backend behind `SyncBackend` stays cheap.
4. **The engine** — `src/shared/sync/engine.ts`. Pull, merge, write locally,
   push. `SyncRunner` coalesces overlapping triggers, because foregrounding the
   app while the launch sync is still running is the normal case.
5. **Token storage**, the one genuinely per-platform piece: `safeStorage` on the
   desktop, Capacitor `Preferences` on the phone. The phone's is the weaker of
   the two and is recorded in `mobile/BACKLOG.md` rather than glossed.
6. **Settings and the triggers** — the code screen, the connected account,
   "sync now"; and sync on launch, on focus/foreground, and eight seconds after
   a local change settles.

## Two rules that had to be replaced, and why

Both were wrong in the same way — they answered a per-episode question with a
per-record fact — and both were found by the user, not by the tests.

**`watchedEpisodes` was a set union.** A union can only grow, so un-marking an
episode was undone by the next sync with any device that still had it marked.
The merge result is written to disk, so the user watched their own change revert
a few seconds after making it, repeatedly. Taking the newer record's set instead
is not the fix: it cannot distinguish *removed this* from *never saw this*, and
silently drops an episode marked on the other device while both were offline.
Only a stamp per episode settles both, which is what `episodeMarks` is.

**The playback position took whichever side was further along.** That sounds
protective and means a series can never be started again — the old position
comes straight back. It is a cursor; the device that moved it last wins.

There was a third, and it was the worst of them: **`migrate` rewrote
`updatedAt`.** It runs on every load, not only on a version change, and it dated
every watchlist record from `addedAt`. Because `addedAt` travels with the record
it is the same number on every device, so after one launch both sides claimed
the identical `updatedAt` and every comparison became a tie. Last-write-wins had
nothing left to compare. Ties prefer the tombstone by design, so an un-delete
could never win either.

The lesson is not about any of the three rules. `migrate` and `merge` each had
good tests and the defect lived in the seam between them: only `merge` reads
the field, only `migrate` corrupted it, and nothing exercised the pair. There
are now tests that compose them.

## Running your own client

Everything below is what a fork needs, and what the released builds do.

The client is created once in the Google Cloud Console: an OAuth client of type
*TVs and Limited Input devices*, the consent screen set to **Production**, and
`drive.file` as the **only** scope. No review, no fee, no waiting. Any
additional scope — even `userinfo.email` — makes the app verification-bound and
reinstates the 100-user cap, silently, at user 101.

The two values go in an untracked `.env`; see `.env.example` for the full
walkthrough. They are deliberately **not** committed. Not for confidentiality —
the secret is extractable from any released binary, and Google's own docs assume
as much for this flow — but because GitHub scans public repositories for this
pattern with Google as a scanning partner, and an automatically revoked secret
would break sync for every user at once.

A build with no `.env` is supported: it compiles, runs, and says in Settings
that sync is unavailable in this build and why.

## Sources

[Device flow for TVs and limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device) ·
[Drive scope tiers](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) ·
[Drive per-file scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) ·
[When verification is required](https://support.google.com/cloud/answer/13463073) ·
[Unverified apps and the 100-user cap](https://support.google.com/cloud/answer/7454865) ·
[Refresh token expiry](https://developers.google.com/identity/protocols/oauth2)
