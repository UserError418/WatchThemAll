# The managed provider catalogue

`providers.json` in this directory is the list the app fetches at runtime, from
`raw.githubusercontent.com/UserError418/WatchThemAll/main/catalog/providers.json`.

## Why it exists

Embed providers die and change domain constantly. On a typical audit of a
shipped catalogue, more than half the entries can no longer produce a stream and
several point at domains their operators have already left. A list baked into a
release is stale within weeks, and the user's only remedy is to wait for a new
build.

Editing this file fixes every install within twelve hours.

## Rules

- **The document is validated all or nothing.** One malformed entry rejects the
  whole file, and every install keeps the list it had. A partially-applied
  catalogue is indistinguishable from a correct one that happens to be missing
  the provider you needed.
- **`version` must be `1`.** Bump it only for an incompatible shape change, and
  expect older installs to ignore the document entirely when you do.
- **`rootUrl` must be HTTPS.** Plain HTTP downgrades the whole player window.
- **Every entry needs at least one of `tv` / `movie`.** An entry serving neither
  can never be chosen.
- **Ids must be unique and stable.** The outcome ledger that teaches Automatic
  mode which provider works is keyed on them, so renaming an id discards
  everything the app has learned.
- **`group` marks mirrors of one backend.** Providers sharing a group are assumed
  to serve the same streams, so the fallback chain tries a different group before
  another member of the same one. Getting this wrong makes failures take several
  times as long to recover from.

## Changing it

Probe before and after. It is the only thing that can tell you whether an entry
works, because every dead provider in this space still answers HTTP 200 with a
plausible-looking page.

```bash
npm run probe:providers                       # everything, ~15 minutes
npm run probe:providers -- --only vidfast     # one entry
npm run probe:providers -- --json report.json # machine-readable
```

A verdict of `stream` means Chromium actually began decoding video. Nothing
weaker is evidence. See [`docs/PROVIDERS.md`](../docs/PROVIDERS.md) for how to
read the other verdicts.
