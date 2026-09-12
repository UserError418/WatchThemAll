# The managed provider catalogue

`providers.json` in this directory is the list the app fetches at runtime, from
`raw.githubusercontent.com/UserError418/WatchThemAll/main/catalog/providers.json`.

## Why this exists

Embed providers die constantly. Measured on 2026-09-06 against the list shipped
in v1.3.0: **eight of fourteen entries could not produce a stream at all**, and
three more pointed at domains their operators had already moved off. A catalogue
baked into a release is stale within weeks, and the user's only remedy is to
wait for a new build of a desktop app.

Editing this file — from a browser, on a phone, in thirty seconds — fixes every
install within twelve hours.

## The rules

- **The app validates this document all-or-nothing.** One malformed entry and
  the whole file is rejected, and every install keeps whatever list it had. That
  is deliberate: a partially-applied catalogue is indistinguishable from a
  correct one that happens to be missing the provider you needed.
- **`version` must be `1`.** Bump it only for an incompatible shape change, and
  expect older installs to ignore the document entirely when you do.
- **`rootUrl` must be HTTPS.** A provider on plain HTTP downgrades the whole
  player window.
- **Every entry needs at least one of `tv` / `movie`.** An entry serving neither
  can never be chosen.
- **Ids must be unique**, and should be stable — the outcome ledger that teaches
  "Automatic" which provider works is keyed on them, so renaming an id throws
  away everything the app has learned about it.
- **`group` marks mirrors of one backend.** Providers sharing a group are
  assumed to serve the same streams, so the fallback chain tries a *different*
  group before another member of the same one. Getting this wrong is not
  cosmetic: it makes failures take five times as long to recover from.

## Changing it

Run the probe before and after. It is the only thing that can tell you whether
an entry works, because every dead provider in this space still answers HTTP
200 with a plausible-looking page:

```bash
npm run probe:providers                       # everything, ~15 minutes
npm run probe:providers -- --only vidfast     # one entry
npm run probe:providers -- --json report.json # machine-readable
```

A verdict of `stream` means Chromium actually began decoding video. Nothing
weaker is evidence.
