# Providers: where the list comes from, and how it stays alive

The app plays nothing itself. It builds a URL from a provider template and loads
it, so the provider list *is* the app's usefulness. This is how that list is
assembled, measured, and maintained.

## Three sources, in one order

`resolveProviders(bundled, cached, custom)` in `src/main/catalog.ts` merges:

1. **Bundled** — `src/main/providers.json`, shipped in the binary. The floor:
   whatever else fails, the app has a list.
2. **Managed** — a JSON document fetched from the repo (`catalog/providers.json`)
   every 12 hours, ETag-cached to disk. Validated **all or nothing**: a document
   with one malformed entry is discarded entirely rather than partially applied,
   because a half-loaded catalogue is a bug that presents as "some titles do not
   play" and is nearly impossible to attribute.
3. **Custom** — whatever the user added in the Providers panel. Last, so a user
   entry with the same id *overrides* the managed one. That is deliberate: the
   user is the only party who can see their own network.

A managed list that cannot be fetched is a silent no-op. The bundled list keeps
working, so a dead URL degrades the app to "not updating" rather than "broken".

## Measuring a provider

`npm run probe:providers` loads each provider's URL in a real browser window and
waits for `media-started-playing`. That event is the only honest success signal:
it fires when Chromium begins decoding, in any frame, however the bytes arrived,
so it catches MSE, blob and WebSocket transports that URL sniffing misses.

Everything cheaper was tried and does not work. **HTTP 200 is worthless here** —
all fourteen entries of the original catalogue returned it, including the ones
that had been dead for months. These are single-page apps: the document loads
clean and *then* asks its own backend for a stream.

```bash
# The shipped catalogue.
npm run probe:providers

# A file of candidates, triaged: stop each provider at its first success.
npm run probe:providers -- --catalog candidates.json --fast --timeout 35000

# One provider, verbose, with the full request log.
npm run probe:providers -- --only vidsrc-me --verbose
```

`--catalog` is what makes evaluating a *new* provider a single command instead of
an edit-build-run cycle against the shipped list. It accepts both shapes — a bare
array and the `{version, providers}` document — so a file pulled straight from the
published catalogue can be probed unmodified.

## What a verdict is allowed to decide

**A probe verdict ranks a provider. It does not decide membership.** This
distinction was learned the expensive way: a first pass deleted seven entries on a
20-second budget, including the VidSrc family, which the user then reported had
been working for them.

They were right, and the reason is in the provider's own HTML. `vidsrcme.ru`
vendors [`disable-devtool`](https://github.com/theajack/disable-devtool) and wires
it to this handler:

```js
function kill() {
    var v = document.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    location.replace('about:blank');
}
DisableDevtool({ disableIframeParents: true, ondevtoolopen: kill });
```

On detecting an instrumented browser it pauses the video, strips its source and
navigates away — which produces *exactly* a `no-media` verdict. The probe runs in
a never-shown window, and a window that was never shown reports the window-size
deltas that library treats as proof of an open devtools panel. **This class of
provider is unmeasurable by an automated probe, by the provider's design.** A
verdict of "did not play" from such a page carries no information about whether it
plays for a person.

So the policy — which is **curation guidance for whoever reads a report**, not
runtime behaviour; nothing persists these verdicts — is:

| Verdict | Meaning | Curation |
|---|---|---|
| `stream` | Verified: media actually decoded | Keep. Note the measurement. |
| `no-media` | Loaded, nothing played — **inconclusive** | Keep. Check by hand before believing it. |
| `api-error` | The provider's own backend returned 4xx/5xx | Keep unless it fails every canary over several runs. |
| `empty` / `unreachable` | No document at all; the host is gone | Remove. |
| `blocked` | Refused our request outright | Remove. |

Only the bottom two rows are grounds for deletion, because only they are
unambiguous. What sorts out the rest is not the probe at all — it is recorded
playback, per user, described next.

## What actually picks the provider

Not the probe. `src/main/outcomes.ts` records, for every attempt, whether that
provider reached playback **for that title on this machine**. `automaticOrder()`
then applies three rules, in this order:

1. **The user's own provider order** — dragged in the Providers panel, stored as
   `providerOrder`. This is the baseline list, not a tiebreak.
2. **Narrowed to sources known to have played this title**, when any have.
   Title-level, matching the green dots the source picker already shows, so the
   list the user sees and the list Automatic walks cannot disagree. Everything
   else is demoted behind it rather than dropped — if the only known-working
   source is down right now, a chain that stops there leaves nothing to try.
3. **Favourites lead each segment** — the starred sources, in the user's order.

Real playback on a real machine outranks any synthetic measurement, which is what
makes the anti-automation problem above survivable: a provider the probe cannot
measure gets measured anyway, by being used.

### What this replaced, and why

Until 2026-09-06 this was a scored ranking: an exact-episode tier with a 14-day
TTL, a mirror-group tier, a Wilson score lower bound over all recorded attempts,
and additive boosts for favourites and for the source a title last streamed on.

It ordered better on paper and was impossible to predict from outside. The
last-used boost outranked the favourite boost, so a single lucky play by a
non-favourite locked that provider in permanently — and the user, who had starred
exactly one provider and knew it worked for the show, reasonably read that as the
favourite setting being broken. A rule the user can state themselves beats a
better rule they cannot, because they are the one who has to trust it.

The source a title last streamed on is still recorded. It is now *shown* — a blue
dot and a blue "resume" label in both source pickers — rather than acted on.

## Mirror groups

Several providers are one backend behind several front pages. Six of the original
fourteen resolved to the same CDN host. A fallback chain that walks all six
"different" providers is a chain of length one that takes six times as long to
fail, so `spreadAcrossGroups()` interleaves across *distinct* backends.

It now runs once, in `defaultProviderOrder()`, to produce the order a fresh
install starts with. After that the user's drag order is law: quietly improving
on an order somebody set by hand is how a setting stops meaning anything.

Groups are detected from measurement, not asserted by hand: the probe records the
registrable host each provider's media actually came from and reports entries that
share one.

## Adding a provider

1. Write it into a candidate file (`id`, `name`, `rootUrl`, and a `movie` and/or
   `tv` `urlTemplate` using `{rootUrl}` `{imdb}` `{tmdb}` `{season}` `{episode}`).
2. `npm run probe:providers -- --catalog that-file.json --fast --timeout 35000`
3. Anything that streams goes in. Anything `unreachable`, `empty` or `blocked`
   does not. Anything `no-media` is a judgement call — check by hand whether the
   page is fighting the probe before believing it.
4. Add it to `src/main/providers.json` **and** `catalog/providers.json`, with a
   `note` recording what was measured and when. Those notes are the only record
   of why an entry is trusted.

Users do not need any of this: **Providers → Add a custom provider** takes the same
fields in the UI, and a custom entry overrides a managed one with the same id.

## Publishing the managed list

`catalog/providers.json` is served over `raw.githubusercontent.com`. Changing what
every install sees is therefore just committing that file — no release, no
rebuild. That is the point of the mechanism, and also its hazard: it is the one
file in this repo that reaches users without going through a build. Probe before
publishing.

Two things about the delivery path will otherwise look like bugs:

- **`raw.githubusercontent.com` caches for about five minutes.** A push does not
  publish; a push plus five minutes publishes. Verify with a plain `curl` of the
  raw URL, not with `git log`.
- **The cached managed list wins outright over the bundled one**, so an install
  that has fetched an *older* catalogue shows fewer providers than the binary
  ships with. That is intended — removing a dead provider is half of what the
  managed list is for, and a union could never do it — but during development it
  reads as "my new provider did not appear". Delete
  `provider-catalog.json` from the data directory to force a refetch.
