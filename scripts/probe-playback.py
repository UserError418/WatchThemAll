#!/usr/bin/env python3
"""Does a captured stream URL actually *play* outside the browser?

`npm run probe:streams` answers the question before this one: it loads a
provider's embed page, captures the media URL with the headers Chromium sent,
and checks that the URL — and one of its segments — still fetches when replayed.
That is necessary and it is not sufficient. A manifest can return 200 and still
be unplayable: the segments may be encrypted with a key the page holds, the
codec may be one the player cannot decode, or the "manifest" may be an HTML
error page served with a 200 because the provider does not believe in status
codes.

The only honest test is to decode frames. So this hands each captured URL to
**mpv** — the player the app would actually embed, not a stand-in — and counts
the PNG files that come out the other side. Pixels on disk cannot be faked by a
403 page.

    npm run probe:streams -- --json /tmp/extract.json
    scripts/probe-playback.py /tmp/extract.json --json /tmp/playback.json

Why a separate script rather than another Electron probe mode: this needs a
system `mpv` binary and no browser at all, which is precisely the property
being measured.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# How long one provider gets to produce frames. Generous: some of these hosts
# are slow enough that a tight timeout would measure their latency rather than
# their playability.
PLAY_TIMEOUT_S = 60

# Enough frames to prove a decode loop is running rather than one lucky
# keyframe. Three costs about a second and rules out a manifest whose first
# segment happens to be a slate.
FRAMES = 3

# Below this, whatever decoded is not a feature film or a TV episode.
#
# This exists because of VidRock, which answers `https://vidrock.net/demo-video.mp4`
# — a placeholder that fetches bare with a 200 and decodes perfectly. Every
# check upstream of this one calls that a success: the URL is a real media URL,
# it needs no headers, and frames come out of it. Only its length gives it away.
# A probe that cannot tell a decoy from the content would have reported the most
# usable provider in the run and been completely wrong.
MIN_FEATURE_SECONDS = 300

# Headers that belong to the browser's own fetch, not to a player's.
SKIP_HEADERS = {
    "host", "connection", "content-length", "accept-encoding",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua",
    "sec-ch-ua-mobile", "sec-ch-ua-platform", "range",
}


class Verdict:
    """What happened, worst last so a sort puts working providers first."""

    PLAYS = "plays"          # frames decoded, and long enough to be the title
    DECOY = "decoy"          # frames decoded, but it is not the film
    DRM = "drm"              # protected by a scheme no open player can handle
    FORBIDDEN = "forbidden"  # the host refused us: 401/403, or a challenge page
    BROKEN = "broken"        # fetched, but nothing decodable came out
    NO_STREAM = "no-stream"  # the extractor never captured a URL


def player_headers(captured: dict[str, str]) -> dict[str, str]:
    """The subset of the browser's headers worth replaying."""
    return {k: v for k, v in captured.items() if k.lower() not in SKIP_HEADERS}


def fetch_text(url: str, headers: dict[str, str], limit: int = 4_000_000) -> tuple[int | None, str]:
    """Fetch a manifest as text. Returns (status, body); status None on failure."""
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read(limit).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, ""
    except Exception:
        return None, ""


def drm_scheme(manifest: str) -> str | None:
    """Name the protection scheme a manifest declares, if any.

    The distinction that matters: **AES-128 is not DRM.** It is ordinary HLS
    encryption, the key is fetched over HTTP like anything else, and ffmpeg
    handles it — so a stream using it is playable if the key URL is reachable.
    SAMPLE-AES and Widevine/PlayReady are a different matter: the key lives
    behind a licence exchange that only a CDM can complete, and no open player
    will ever decode them. Treating the two the same would write off providers
    that work.
    """
    if re.search(r"#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES", manifest, re.I):
        return "SAMPLE-AES"
    if re.search(r"<ContentProtection", manifest, re.I):
        return "MPEG-DASH ContentProtection"
    if re.search(r"urn:uuid:edef8ba9", manifest, re.I):
        return "Widevine"
    return None


def hls_duration(manifest: str) -> float | None:
    """Sum an HLS media playlist's own segment durations.

    Preferred over asking ffprobe, for a reason worth recording: ffmpeg 9
    refuses these playlists outright. VidZee's segments have no file extension,
    which trips `allowed_segment_extensions` — "consider updating hls.c and
    submitting a patch", says ffprobe, and returns "Invalid data found". mpv
    plays the same URL without complaint, so a duration read through ffprobe
    would report nothing for exactly the providers that work.

    `#EXTINF` is in the manifest we already fetched. Adding it up is exact for
    VOD, needs no subprocess, and cannot disagree with the player.
    """
    if "#EXTINF" not in manifest:
        return None
    total = 0.0
    for match in re.finditer(r"#EXTINF:\s*([0-9.]+)", manifest):
        total += float(match.group(1))
    return total or None


def probe_duration(url: str, headers: dict[str, str]) -> float | None:
    """Duration for anything that is not an HLS media playlist.

    A master playlist and a progressive file both need ffprobe. `-allowed_extensions ALL`
    is passed for the same reason `hls_duration` exists.
    """
    args = ["ffprobe", "-v", "error", "-allowed_extensions", "ALL",
            "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]
    for name, value in headers.items():
        if name.lower() == "user-agent":
            args += ["-user_agent", value]
        else:
            args += ["-headers", f"{name}: {value}\r\n"]
    args.append(url)
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=PLAY_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None
    match = re.search(r"([0-9]+\.?[0-9]*)", done.stdout)
    return float(match.group(1)) if match else None


def header_args(headers: dict[str, str]) -> list[str]:
    """Translate captured browser headers into mpv's own options."""
    args = []
    for name, value in headers.items():
        if name.lower() == "user-agent":
            args.append(f"--user-agent={value}")
        elif name.lower() == "referer":
            args.append(f"--referrer={value}")
        else:
            args.append(f"--http-header-fields-append={name}: {value}")
    return args


def run_mpv(url: str, headers: dict[str, str], outdir: Path) -> tuple[int, str]:
    """Decode a few frames to PNG. Returns (frames written, mpv's stderr)."""
    args = [
        "mpv", "--no-config",
        # Write real pixels. `--vo=null` would exit 0 on a stream that produced
        # no video at all, which is the exact failure being looked for.
        "--vo=image", "--vo-image-format=png", f"--vo-image-outdir={outdir}",
        "--ao=null", f"--frames={FRAMES}", "--untimed",
        "--network-timeout=20",
        # Software decode on purpose: this measures whether the *stream* is
        # playable, and a missing nvdec profile would otherwise be reported as
        # the provider's fault.
        "--hwdec=no",
        "--msg-level=all=warn",
    ]
    args += header_args(headers)
    args.append(url)

    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=PLAY_TIMEOUT_S)
        stderr = done.stderr
    except subprocess.TimeoutExpired as err:
        stderr = (err.stderr or b"").decode("utf-8", "replace") if isinstance(err.stderr, bytes) else (err.stderr or "")
        stderr += "\n[timed out]"
    return len(list(outdir.glob("*.png"))), stderr.strip()


def classify(frames: int, stderr: str, status: int | None, scheme: str | None,
             duration: float | None) -> str:
    if frames > 0:
        # A duration we could not read is not evidence of a decoy — live HLS
        # legitimately reports none — so only a *known* short one is rejected.
        if duration is not None and duration < MIN_FEATURE_SECONDS:
            return Verdict.DECOY
        return Verdict.PLAYS
    if scheme:
        return Verdict.DRM
    if status in (401, 403) or re.search(r"\b40[13]\b", stderr):
        return Verdict.FORBIDDEN
    return Verdict.BROKEN


def probe(result: dict) -> dict:
    """One provider: manifest inspection, then a real decode."""
    stream = result.get("stream")
    row = {
        "providerId": result["providerId"],
        "providerName": result["providerName"],
        "extractVerdict": result.get("verdict"),
        "kind": stream.get("kind") if stream else None,
        "verdict": Verdict.NO_STREAM,
        "frames": 0,
        "manifestStatus": None,
        "drmScheme": None,
        "resolution": None,
        "durationS": None,
        "note": "",
    }
    if not stream:
        row["note"] = "extractor captured no media URL"
        return row

    # `open` means the URL fetched with no headers at all. Replaying the
    # browser's headers anyway would hide that, and "works bare" is a materially
    # better answer than "works if we impersonate the page".
    headers = {} if result.get("verdict") == "open" else player_headers(stream.get("headers", {}))

    status, body = fetch_text(stream["url"], headers)
    row["manifestStatus"] = status
    row["drmScheme"] = drm_scheme(body)
    duration = hls_duration(body) or probe_duration(stream["url"], headers)
    row["durationS"] = round(duration, 1) if duration is not None else None

    with tempfile.TemporaryDirectory() as tmp:
        outdir = Path(tmp)
        frames, stderr = run_mpv(stream["url"], headers, outdir)
        row["frames"] = frames
        if frames:
            first = sorted(outdir.glob("*.png"))[0]
            row["resolution"] = png_size(first)

    row["verdict"] = classify(frames, stderr, status, row["drmScheme"], duration)
    if row["verdict"] == Verdict.DECOY:
        row["note"] = f"decoded, but only {row['durationS']}s long — not the title"
    elif row["verdict"] != Verdict.PLAYS:
        row["note"] = first_complaint(stderr)
    return row


def png_size(path: Path) -> str | None:
    """Width x height straight out of the PNG header — no image library needed."""
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return f"{width}x{height}"


def first_complaint(stderr: str) -> str:
    """The first line of mpv's output that looks like a reason."""
    for line in stderr.splitlines():
        line = line.strip()
        if line and not line.startswith("("):
            return line[:150]
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("extract_json", help="output of `npm run probe:streams -- --json`")
    parser.add_argument("--json", help="write the full results here")
    parser.add_argument("--only", nargs="*", default=[], help="limit to these provider ids")
    args = parser.parse_args()

    if not shutil.which("mpv"):
        print("mpv is not installed; this measures nothing without it", file=sys.stderr)
        return 2

    results = json.loads(Path(args.extract_json).read_text())
    if args.only:
        results = [r for r in results if r["providerId"] in args.only]

    print(f"\nAttempting real playback for {len(results)} provider(s) with mpv {FRAMES} frames each.")
    print("plays = frames decoded, feature-length · decoy = decoded but far too short · "
          "drm = licence-gated · forbidden = refused us · broken = no decodable video\n")

    rows = []
    for result in results:
        sys.stderr.write(f"  … {result['providerId']}\n")
        row = probe(result)
        rows.append(row)
        print(
            f"{row['providerName'][:14]:<14} {row['verdict']:<10} "
            f"{str(row['kind'] or '—'):<12} frames:{row['frames']:<3} "
            f"{str(row['resolution'] or '—'):<10} "
            f"dur:{str(row['durationS'] or '—'):<8} manifest:{row['manifestStatus'] or '—'}"
        )
        if row["drmScheme"]:
            print(f"               drm: {row['drmScheme']}")
        if row["note"]:
            print(f"               {row['note']}")

    playable = [r for r in rows if r["verdict"] == Verdict.PLAYS]
    print(f"\n{len(playable)}/{len(rows)} provider(s) play outside the browser.")
    for r in playable:
        print(f"  {r['providerName']} ({r['resolution']}, {r['durationS']}s)")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2))
        print(f"Wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
