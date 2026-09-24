# Providers

The app plays nothing itself. It renders a URL from a provider template and
loads it, so the provider list is the app's usefulness. This is how that list is
assembled, measured and maintained.

## Three sources, in one order

`resolveProviders(bundled, cached, custom)` in `src/main/catalog.ts` merges:

1. **Bundled** — `src/main/providers.json`, shipped in the binary. The floor:
   whatever else fails, the app has a list.
2. **Managed** — `catalog/providers.json`, fetched from the repo every 12 hours
   and ETag-cached. Validated all or nothing; a document with one malformed
   entry is discarded entirely, because a half-applied catalogue presents as
   "some titles do not play" and is nearly impossible to attribute.
3. **Custom** — whatever the user added in the Providers panel. Last, so a user
   entry overrides a managed one with the same id. The user is the only party
   who can see their own network.

A managed list that cannot be fetched is a silent no-op, so a dead URL degrades
the app to "not updating" rather than "broken".

## Measuring a provider

`npm run probe:providers` loads each provider's URL in a real browser window and
waits for `media-started-playing`. That event fires when Chromium begins
decoding, in any frame, however the bytes arrived, so it catches MSE, blob and
WebSocket transports that URL sniffing misses.

Nothing cheaper works. **HTTP 200 is worthless here** — every entry of an
audited catalogue returned it, including entries dead for months. These are
single-page apps: the document loads clean and then asks its own backend for a
stream.

```bash
npm run probe:providers                                    # the shipped catalogue
npm run probe:providers -- --only vidsrc-me --verbose      # one entry, full request log
npm run probe:providers -- --catalog candidates.json --fast --timeout 35000
```

`--catalog` accepts both a bare array and the `{version, providers}` document, so
a file pulled from the published catalogue can be probed unmodified.

## What a verdict may decide

**A verdict ranks a provider. It does not decide membership.**

Some providers actively defeat measurement. A common library detects an
instrumented browser from window-size deltas — which a never-shown probe window
always reports — then pauses the video, strips its source and navigates away.
That produces exactly a `no-media` verdict while the same URL plays fine for a
person. This class of provider is unmeasurable by an automated probe, by design,
so a `no-media` result carries no information either way.

The resulting curation policy (guidance for whoever reads a report; nothing
persists these verdicts):

| Verdict | Meaning | Curation |
|---|---|---|
| `stream` | Media actually decoded | Keep. Record the measurement. |
| `no-media` | Loaded, nothing played — **inconclusive** | Keep. Check by hand. |
| `api-error` | The provider's backend returned 4xx/5xx | Keep unless it fails every canary over several runs. |
| `empty` / `unreachable` | No document; the host is gone | Remove. |
| `blocked` | Refused the request outright | Remove. |

Only the last two rows are unambiguous, and only they are grounds for deletion.

## What actually picks the provider

Not the catalogue probe. Two facts about the title in hand decide it:
`src/main/outcomes.ts` records, per attempt, whether a provider reached playback
for that title on that machine, and **Test all sources** measures every provider
against it on demand. `scanAwareOrder()` in `src/main/providerscan.ts` sorts by
those facts, in tiers:

1. measured streaming by a test in the last six hours
2. has played this title before
3. answered a test, but no stream appeared
4. nothing known either way
5. tried before and never produced a stream
6. measured dead by a test in the last six hours

Within a tier, **favourites lead**, then **the user's own provider order** from
the Providers panel decides. A measurement moves a provider between tiers; it
never reorders providers the user has placed relative to each other.

The dots in both source pickers are coloured by the same function the tiers come
from, `providerRank` in `src/shared/scanrank.ts`, so a green row is always one
Automatic reaches for before any row that is not green.

A fresh test outranks history in both directions, because it is the more recent
fact about a service that changes daily. Without one, real playback on the
user's own machine is what decides, which is what makes the anti-automation
problem survivable: a provider no probe can measure gets measured by being used.

The rule is deliberately one a user can state themselves. A scored ranking —
decaying weights, confidence intervals over recorded attempts — can order better
on paper and still read as broken, because nobody can predict it from outside,
and the user is the one who has to trust it.

The source a title last streamed on is recorded too. It is shown — a blue dot
and a "resume" label in both source pickers — rather than acted on.

## Checking that the right title plays

A stream playing is not the same as the right title playing. A provider can pass
every check above while serving something else entirely, and the two ways that
happens are both template mistakes that still produce video:

- **The wrong kind of id.** Most providers read a bare number as a TMDB id for
  the path's media type, so a series id on a film path is some unrelated film.
  SuperEmbed reads a bare number as an IMDB id unless the URL also says
  `tmdb=1`. A template has to use the id type the provider documents, not one
  that happens to load.
- **An ignored season or episode.** A provider that does not read them serves
  the pilot for every episode, which is exactly what a canary set made of pilots
  cannot notice.

A third comes from providers themselves: a backend that looks titles up by
*name* serves a same-named title instead. *One Piece* the anime and *One Piece*
the live-action series share a name and differ in length, and one backend in
this space serves the live-action episode for the anime's id.

`--canaries content` swaps in titles chosen so that each of these shows up as a
wrong *length*: late episodes that run far longer than their show's pilot, and
the anime *One Piece*. `--evidence DIR` also records every frame's visible text,
which usually names the title and episode, and a screenshot taken 40% into the
title, which is the part least alike between one episode and the next.

```bash
npm run probe:ui -- --canaries content --catalog candidates.json \
  --timeout 45000 --evidence /tmp/shots
```

Every line reports the delivered length against TMDB's, as in `142m of 143m`. A
mismatch is flagged; a match is still only evidence about length, so look at the
screenshot before trusting a template.

## Mirror groups

Several providers are one backend behind several front pages. A fallback chain
that walks all of them is a chain of length one that takes several times as long
to fail, so `spreadAcrossGroups()` interleaves across distinct backends.

It runs once, in `defaultProviderOrder()`, to produce the order a fresh install
starts with. After that the user's drag order is law: quietly improving on an
order somebody set by hand is how a setting stops meaning anything.

Groups are detected from measurement. The probe records the registrable host each
provider's media actually came from and reports entries that share one.

## Adding a provider

1. Write it into a candidate file: `id`, `name`, `rootUrl`, and a `movie` and/or
   `tv` `urlTemplate` using `{rootUrl}` `{imdb}` `{tmdb}` `{season}` `{episode}`.
2. `npm run probe:providers -- --catalog that-file.json --fast --timeout 35000`
   to see whether it streams at all, then the content check above to see
   whether it streams the right thing.
3. Anything that streams the right title goes in. Anything `unreachable`, `empty` or `blocked`
   does not. `no-media` is a judgement call — check by hand whether the page is
   fighting the probe.
4. Add it to `src/main/providers.json` **and** `catalog/providers.json` with a
   `note` recording what was measured and when. Those notes are the only record
   of why an entry is trusted.

Users need none of this: **Providers → Add a custom provider** takes the same
fields in the UI.

## Publishing the managed list

`catalog/providers.json` is served over `raw.githubusercontent.com`, so changing
what every install sees is just committing that file — no release, no rebuild.
It is also the one file here that reaches users without passing through a build.
Probe before publishing.

Two things about the delivery path otherwise look like bugs:

- **`raw.githubusercontent.com` caches for about five minutes.** Verify with a
  plain `curl` of the raw URL, not with `git log`.
- **A cached managed list wins outright over the bundled one**, so an install
  holding an older catalogue shows fewer providers than the binary ships with.
  That is intended — removing a dead provider is half of what the managed list is
  for — but in development it reads as "my new provider did not appear". Delete
  `provider-catalog.json` from the data directory to force a refetch.
