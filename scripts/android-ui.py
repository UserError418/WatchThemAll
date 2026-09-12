#!/usr/bin/env python3
"""Drive the Android app the way a finger does, and read the result back.

`scripts/cdp.py` already talks to the WebView — an Android debug build turns on
`setWebContentsDebuggingEnabled`, so `adb forward tcp:<port>
localabstract:webview_devtools_remote_<pid>` gives the same CDP session the
desktop app exposes directly. That is enough to *measure* the page and not
enough to *test* it: a click dispatched from CDP proves the handler works and
says nothing about whether a finger can reach the element. Every Android-only
layout fault this script was written for — a control under the status bar, a
control behind the gesture pill, a control off the right edge — passes a
synthetic click and fails a real tap.

So taps go through `adb shell input tap`, in device pixels, and this script
owns the conversion. Two corrections are needed and neither is guessable:

* **Device pixel ratio.** `1080x2400 at 420dpi` is a `412x914` CSS viewport,
  so a CSS coordinate is 2.625 device pixels here. Read from the page.
* **The WebView's offset down the screen.** Capacitor lays the WebView out
  *between* the system bars on WebView versions below 140, so CSS `y=0` is 136
  device pixels down, not 0. Measured per run from the difference between the
  screen height and the viewport height, because it depends on the device's
  WebView version rather than on anything in this repository.

Usage:

    scripts/android-ui.py tap '.play'          # tap the first match
    scripts/android-ui.py tap-text 'Play'      # tap a button by its label
    scripts/android-ui.py rect '.player'       # CSS and device rects, as JSON
    scripts/android-ui.py shot /tmp/x.png      # the device framebuffer
    scripts/android-ui.py eval 'innerHeight'   # straight through to cdp.py

`--port` and `--package` default to the values `npm run apk` produces. The
forward is (re)established on every run: the WebView's pid changes whenever the
app restarts, and a stale forward fails in a way that reads like a hung page.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from cdp import CDP, find_target  # noqa: E402

DEFAULT_PACKAGE = "net.watchthemall.app"
DEFAULT_PORT = 9222


def adb(*args: str, binary: bool = False) -> bytes | str:
    """Run adb and return its output, raising on a non-zero exit."""
    result = subprocess.run(
        ["adb", *args], capture_output=True, check=True
    )
    return result.stdout if binary else result.stdout.decode().strip()


def connect(package: str, port: int) -> CDP:
    """Point `port` at the app's WebView and open a CDP session on it.

    The pid is re-read every time rather than cached: `adb forward` happily
    keeps a rule pointing at a socket that no longer exists, and the resulting
    connection refusal looks identical to the app having crashed.
    """
    pid = adb("shell", "pidof", package)
    if not pid:
        raise SystemExit(f"{package} is not running")
    adb("forward", "--remove-all")
    adb("forward", f"tcp:{port}", f"localabstract:webview_devtools_remote_{pid}")
    return CDP(find_target(port, "localhost"))


def geometry(cdp: CDP) -> tuple[float, float]:
    """`(devicePixelRatio, top offset in device pixels)` for this WebView."""
    page = cdp.evaluate("JSON.stringify([devicePixelRatio, innerHeight])")
    ratio, inner_height = json.loads(page)

    size = adb("shell", "wm", "size")
    screen_h = int(size.rsplit("x", 1)[1])

    # The WebView is centred vertically between the bars in the letterboxed
    # case and fills the screen in the edge-to-edge one; the status bar is the
    # top share of whatever is left over. Asking the window manager for the
    # inset directly would be exact, but it is reported per-display and per
    # rotation and this arithmetic holds for both.
    leftover = screen_h - inner_height * ratio
    top = 0.0 if leftover < 2 else float(adb_status_bar_px())
    return ratio, top


def adb_status_bar_px() -> int:
    """The status bar's height in device pixels, from the window manager."""
    dump = adb("shell", "dumpsys", "window", "displays")
    for line in dump.splitlines():
        if "overrideNonDecorInsets" not in line:
            continue
        # `overrideNonDecorInsets=[0,136][0,63]` — left,top then right,bottom.
        after = line.split("overrideNonDecorInsets=[", 1)[1]
        return int(after.split("]", 1)[0].split(",")[1])
    raise SystemExit("could not read the status bar inset from dumpsys")


def css_rect(cdp: CDP, expression: str) -> dict:
    """The first matching element's viewport rect, or exit with a diagnosis."""
    raw = cdp.evaluate(
        f"""(() => {{
          const el = {expression};
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({{
            x: r.x, y: r.y, width: r.width, height: r.height,
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          }});
        }})()"""
    )
    if raw is None:
        raise SystemExit(f"no element matched: {expression}")
    return json.loads(raw)


def to_device(rect: dict, ratio: float, top: float) -> tuple[int, int]:
    """The centre of `rect`, in device pixels."""
    return (
        round((rect["x"] + rect["width"] / 2) * ratio),
        round((rect["y"] + rect["height"] / 2) * ratio + top),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["tap", "tap-text", "rect", "shot", "eval"])
    parser.add_argument("argument")
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--settle",
        type=float,
        default=0.0,
        help="seconds to wait after a tap before returning",
    )
    args = parser.parse_args()

    if args.command == "shot":
        with open(args.argument, "wb") as out:
            out.write(adb("exec-out", "screencap", "-p", binary=True))
        print(args.argument)
        return

    cdp = connect(args.package, args.port)
    try:
        if args.command == "eval":
            print(json.dumps(cdp.evaluate(args.argument), indent=2))
            return

        if args.command == "tap-text":
            selector = (
                "[...document.querySelectorAll('button, a, [role=button]')]"
                f".find((e) => (e.textContent || '').trim().includes({json.dumps(args.argument)}))"
            )
        else:
            selector = f"document.querySelector({json.dumps(args.argument)})"

        rect = css_rect(cdp, selector)
        ratio, top = geometry(cdp)
        x, y = to_device(rect, ratio, top)

        if args.command == "rect":
            print(json.dumps({**rect, "deviceX": x, "deviceY": y}, indent=2))
            return

        adb("shell", "input", "tap", str(x), str(y))
        print(f"tapped {rect['text'] or args.argument!r} at device {x},{y}")
        if args.settle:
            time.sleep(args.settle)
    finally:
        cdp.close()


if __name__ == "__main__":
    main()
