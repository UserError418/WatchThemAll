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

Not the probe. `src/main/outcomes.ts` records, per attempt, whether a provider
reached playback for that title on that machine. `automaticOrder()` then applies
three rules in order:

1. **The user's own provider order**, dragged in the Providers panel. The
   baseline list, not a tiebreak.
2. **Narrowed to sources known to have played this title**, when any have. This
   matches the green dots in the source picker, so the list the user sees and the
   list Automatic walks cannot disagree. Everything else is demoted behind it
   rather than dropped, so a chain still has somewhere to go if the known-good
   source is down.
3. **Favourites lead each segment**, in the user's order.

Real playback on a real machine outranks any synthetic measurement, which is what
makes the anti-automation problem survivable: a provider the probe cannot measure
gets measured by being used.

This replaced a scored ranking — tiered TTLs, a Wilson score over recorded
attempts, additive boosts. It ordered better on paper and was impossible to
predict from outside; a single lucky play by a non-favourite could outrank a
starred provider permanently, which reads to a user as the favourite setting
being broken. A rule a user can state themselves beats a better rule they cannot,
because they are the one who has to trust it.

The source a title last streamed on is still recorded. It is now shown — a blue
dot and a "resume" label in both source pickers — rather than acted on.

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
3. Anything that streams goes in. Anything `unreachable`, `empty` or `blocked`
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
