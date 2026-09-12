#!/usr/bin/env python3
"""Drive the running app over the Chrome DevTools Protocol.

CDP is the first tool to reach for because it yields assertable facts — which
image origins loaded, CSP violations, DOM counts — instead of a picture
somebody has to interpret.

It is not sufficient for the player. The video and its chrome are native
`WebContentsView`s composited by the window, so a screenshot of any single
target shows that target alone and never their arrangement. For those, capture
the X root window under Xvfb (`import -display :99 -window root`), which does
work here — the claim that screen capture fails on this machine is about
rootless XWayland, not about Xvfb.

Start the app with a debugging port, then point this at it:

    electron . --no-sandbox --remote-debugging-port=9333
    python3 scripts/cdp.py 'document.querySelectorAll("article").length'

Only the standard library is used, deliberately: needing `npm install` to
diagnose a build would make this useless exactly when it is most wanted.

One non-obvious behaviour is worth knowing before trusting a result. A window
that is never composited — which is what happens when the app is launched from
a headless session — gets no rendering opportunities, so `requestAnimationFrame`
never runs and `IntersectionObserver` never fires. Anything gated on those
appears broken while being perfectly healthy. Pass --screencast to force the
compositor to produce frames, which makes both work.
"""

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.request
from urllib.parse import urlparse

DEFAULT_PORT = 9333


class ProtocolError(RuntimeError):
    """The page returned an error, or evaluated expression threw."""


class CDP:
    """A single WebSocket session against one CDP target.

    Deliberately minimal: enough to send commands and read their replies, with
    events discarded rather than dispatched. Nothing here needs to observe an
    event, and a subscription model would be more code to get wrong.
    """

    def __init__(self, ws_url: str, timeout: float = 90.0) -> None:
        parsed = urlparse(ws_url)
        self._sock = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
        self._handshake(parsed)
        self._next_id = 0

    def _handshake(self, parsed) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {parsed.path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.send(request.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ProtocolError("connection closed during WebSocket handshake")
            buf += chunk

    def _frame_send(self, payload: str) -> None:
        data = payload.encode()
        header = bytearray([0x81])
        mask = os.urandom(4)
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        header += mask
        header += bytes(byte ^ mask[i % 4] for i, byte in enumerate(data))
        self._sock.send(bytes(header))

    def _read_exactly(self, count: int) -> bytes:
        buf = b""
        while len(buf) < count:
            chunk = self._sock.recv(count - len(buf))
            if not chunk:
                raise ProtocolError("connection closed mid-frame")
            buf += chunk
        return buf

    def _frame_recv(self) -> str:
        """Return the next text frame, skipping binary and control frames."""
        while True:
            header = self._read_exactly(2)
            length = header[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exactly(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exactly(8))[0]
            payload = self._read_exactly(length)
            if header[0] & 0x0F == 1:
                return payload.decode()

    def send(self, method: str, params: dict | None = None) -> dict:
        """Send one command and return its result, discarding events in between."""
        self._next_id += 1
        message_id = self._next_id
        self._frame_send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self._frame_recv())
            if message.get("id") != message_id:
                continue  # An event, or a reply we already returned.
            if "error" in message:
                raise ProtocolError(f"{method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression: str):
        """Evaluate an expression in the page and return its value.

        Promises are awaited, so an expression may be an async IIFE — which is
        how anything touching the IPC bridge has to be written.
        """
        result = self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        if "exceptionDetails" in result:
            raise ProtocolError(json.dumps(result["exceptionDetails"])[:800])
        return result.get("result", {}).get("value")

    def force_rendering(self) -> None:
        """Make the compositor produce frames for a window that is not on screen.

        Without this, a page launched from a headless session gets no rendering
        opportunities at all: `requestAnimationFrame` never runs, so anything
        driven by `IntersectionObserver` sits untouched forever and looks like a
        bug in the app rather than a property of the environment.
        """
        self.send("Page.enable")
        self.send("Page.startScreencast", {"format": "png", "maxWidth": 1600, "maxHeight": 1000})

    def screenshot(self, path: str) -> int:
        """Write a PNG of the page and return its size in bytes."""
        result = self.send("Page.captureScreenshot", {"format": "png"})
        data = base64.b64decode(result["data"])
        with open(path, "wb") as handle:
            handle.write(data)
        return len(data)

    def close(self) -> None:
        self._sock.close()


def find_target(port: int, url_contains: str, target_type: str = "page", timeout: float = 60.0) -> str:
    """Wait for a target whose URL contains `url_contains`, return its socket URL.

    Polling rather than connecting once: the app is usually still starting when
    this runs, and the renderer target does not exist until it does.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as response:
                for target in json.load(response):
                    if target_type != "any" and target.get("type") != target_type:
                        continue
                    if url_contains in target.get("url", ""):
                        return target["webSocketDebuggerUrl"]
        except OSError:
            pass  # The debugging port is not listening yet.
        time.sleep(1)
    raise SystemExit(f"no {target_type} target matching {url_contains!r} on port {port}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expression", help="JavaScript to evaluate in the page")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--match", default="index.html", help="substring of the target's URL")
    parser.add_argument(
        "--target-type",
        default="page",
        help=(
            "CDP target type to attach to, or 'any'. The default excludes iframes, "
            "which is right for the app window and wrong for the player: a provider "
            "runs in a cross-origin frame that the shell page cannot script into, so "
            "reaching its <video> means attaching to the frame itself."
        ),
    )
    parser.add_argument("--screencast", action="store_true", help="force the page to render first")
    parser.add_argument("--settle", type=float, default=0.0, help="seconds to wait before evaluating")
    parser.add_argument("--screenshot", metavar="PATH", help="also write a PNG here")
    args = parser.parse_args()

    client = CDP(find_target(args.port, args.match, args.target_type))
    try:
        if args.screencast:
            client.force_rendering()
        if args.settle:
            time.sleep(args.settle)
        print(json.dumps(client.evaluate(args.expression), indent=2, default=str))
        if args.screenshot:
            print(f"wrote {client.screenshot(args.screenshot)} bytes to {args.screenshot}", file=sys.stderr)
    finally:
        client.close()


if __name__ == "__main__":
    main()
