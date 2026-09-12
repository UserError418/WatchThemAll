#!/usr/bin/env python3
"""Ask each provider, on a real Android device, whether it actually streams.

The desktop has `--probe-providers`, which watches the player view's own
network traffic and calls a provider working the moment it requests a media
manifest or a segment. That check cannot run on Android: it is built on
Electron's `webRequest` API and on the main process's ability to script any
frame, and a WebView grants neither.

Two weaker substitutes were tried first and both mislead:

* **A screenshot diff.** "Did the picture move" is satisfied by a spinner, by
  an ad, and by a provider's own idle animation — and *not* satisfied by a
  provider that is streaming perfectly while paused on its first frame waiting
  for a tap. It cannot tell "will not play" from "has not been asked to".
* **Reading the `<video>`.** The element lives in a cross-origin document
  nested inside the embed, which this session cannot script.

What does work is the same evidence the desktop probe uses, from the other
end: the WebView's CDP session reports `Network.requestWillBeSent` for every
request the page makes *including its subframes*, because an Android WebView
does not put cross-origin frames in their own process. So the media pattern
below is `streamprobe.ts`'s, deliberately — two definitions of "a stream
started" would eventually disagree about the same provider.

    scripts/android-provider-probe.py vidlux,vidfast,vidflix --seconds 25

The app must already be playing something: this drives `wtaChrome
.switchProvider`, which is the same path the user's own source menu takes.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from cdp import CDP, find_target  # noqa: E402

# Both copied from `src/main/streamprobe.ts`. Keep them in step.
MEDIA_PATTERN = re.compile(
    r"\.(m3u8|mpd|ts|m4s|mp4|webm)(\?|$)|/segment|/manifest", re.IGNORECASE
)
MEDIA_MIME = re.compile(
    r"^(application/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video/|audio/)",
    re.IGNORECASE,
)

#: How long the outgoing provider is given to stop fetching. Measured: an HLS
#: player keeps pulling segments for several seconds after its document is
#: navigated away, which is long enough to be credited to its successor.
BLANK_SETTLE_SECONDS = 6.0


def connect(package: str, port: int) -> CDP:
    pid = subprocess.run(
        ["adb", "shell", "pidof", package], capture_output=True, check=True
    ).stdout.decode().strip()
    if not pid:
        raise SystemExit(f"{package} is not running")
    subprocess.run(["adb", "forward", "--remove-all"], check=True, capture_output=True)
    subprocess.run(
        ["adb", "forward", f"tcp:{port}", f"localabstract:webview_devtools_remote_{pid}"],
        check=True,
        capture_output=True,
    )
    return CDP(find_target(port, "localhost"))


def classify(events: list[dict]) -> dict:
    """Summarise one provider's traffic into a verdict and its evidence."""
    requests: list[str] = []
    media: list[str] = []
    failures: list[str] = []

    for event in events:
        method = event.get("method")
        params = event.get("params", {})
        if method == "Network.requestWillBeSent":
            url = params.get("request", {}).get("url", "")
            requests.append(url)
            if MEDIA_PATTERN.search(url) or params.get("type") == "Media":
                media.append(url)
        elif method == "Network.responseReceived":
            mime = params.get("response", {}).get("mimeType", "")
            if MEDIA_MIME.match(mime) or params.get("type") == "Media":
                media.append(params.get("response", {}).get("url", ""))
        elif method == "Network.loadingFailed":
            failures.append(params.get("errorText", ""))

    return {
        # "stream" only for media traffic, exactly as the desktop probe scores
        # it. "loaded" means the embed's own page came up and asked for nothing
        # playable, which on these hosts means either a gate the user has to
        # tap or a refusal — the screenshot is what tells those apart.
        "verdict": "stream" if media else ("loaded" if len(requests) > 3 else "dead"),
        "requests": len(requests),
        "media": len(media),
        "firstMedia": media[0][:110] if media else None,
        "failures": len(failures),
        "topFailures": sorted(set(failures))[:3],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("providers", help="comma-separated provider ids")
    parser.add_argument("--seconds", type=float, default=25.0)
    parser.add_argument("--package", default="net.watchthemall.app")
    parser.add_argument("--port", type=int, default=9222)
    args = parser.parse_args()

    results = {}
    for provider in args.providers.split(","):
        # A fresh session per provider: the collected events are per-connection
        # and mixing two providers' traffic would credit one with the other's.
        cdp = connect(args.package, args.port)
        try:
            # Blank the surface and let the outgoing provider finish dying
            # before counting anything. Without this the first run credited
            # VidFast with 106 media requests while its page was showing
            # "Please Disable Sandbox" — every one of them was the *previous*
            # provider's HLS buffering, still draining from a document that had
            # been navigated away seconds earlier. A probe that reports a
            # refusal as a stream is worse than no probe.
            cdp.evaluate(
                'document.getElementById("wta-player-surface")'
                "?.querySelector('iframe')?.setAttribute('src', 'about:blank')"
            )
            cdp.collect(BLANK_SETTLE_SECONDS)
            cdp.events.clear()

            cdp.send("Network.enable")
            cdp.evaluate(f"window.wtaChrome.switchProvider({json.dumps(provider)})")
            cdp.collect(args.seconds)
            url = cdp.evaluate(
                'document.getElementById("wta-player-surface")'
                "?.querySelector('iframe')?.src ?? null"
            )
            results[provider] = {**classify(cdp.events), "url": url}
        finally:
            cdp.close()
        row = results[provider]
        print(
            f"{provider:<12} {row['verdict']:<7} "
            f"req={row['requests']:<4} media={row['media']:<3} "
            f"fail={row['failures']:<3} {row['url']}"
        )

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
