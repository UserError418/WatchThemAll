/**
 * Serves the built renderer over loopback HTTP.
 *
 * This exists for one concrete reason, verified rather than assumed:
 * **YouTube will not embed into a page whose origin is not http(s).** Loaded
 * from `file://` the player answers "Video player configuration error"
 * (error 153), and a custom privileged `app://` scheme — standard and secure,
 * with a real origin tuple — is refused exactly the same way. The identical
 * page served from `http://127.0.0.1` plays immediately.
 *
 * That matters more than it sounds: a dev build gets its renderer from Vite on
 * `http://localhost`, so trailers work perfectly while developing and fail in
 * every packaged build. This closes that gap.
 *
 * Safety properties, in order of how much they matter:
 *
 * - **Bound to 127.0.0.1**, never a wildcard. Nothing off this machine can
 *   reach it, so it is not a network service in any meaningful sense.
 * - **Ephemeral port**, chosen by the OS at launch.
 * - **Serves one directory**, with resolved paths checked against it, so a
 *   traversal cannot read outside the bundle.
 * - The bundle contains no secrets. The TMDB key is read in the main process
 *   and never reaches renderer code.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize, sep, extname } from 'node:path'

/** Content types for what a Vite build actually emits. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

let server: Server | null = null

/**
 * Start the server and resolve with the base URL to load.
 *
 * Idempotent: calling it again returns the address of the running server, so
 * re-creating the window on `activate` does not start a second one.
 */

/* ── The player shell ───────────────────────────────────────────────────────
 *
 * A page whose only content is a full-bleed iframe pointing at the provider.
 *
 * ## Why the video is framed rather than loaded directly
 *
 * Providers are embed products: their business is being an `<iframe>` on
 * somebody else's site, and they have started enforcing it. Videasy began
 * answering 403 to every title, and bisecting the request headers isolated it
 * to one — `Sec-Fetch-Dest: document` was refused where `iframe` was allowed.
 * Rewriting the header got the document to 200 and no further: the page then
 * aborted its own scripts, because a player that checks `Sec-Fetch-Dest` also
 * checks `window.top !== window.self`, and a spoofed header cannot answer that.
 *
 * Framing it for real answers both at once, and it is also simply true — the
 * app hosts the provider inside its own chrome, which is what an embedding page
 * does. Measured: the identical URL that returns 403 as a top-level navigation
 * loads completely inside an iframe served from an http origin.
 *
 * A `data:` URL will not do. The parent needs a real origin, or the frame's
 * `Referer` and `Origin` are `null` — which is the hotlink signature these same
 * hosts reject.
 *
 * ## What still works through the frame
 *
 * Reading the video position and seeking already walked
 * `webContents.mainFrame.framesInSubtree`, because providers nest their player
 * one or two frames deep on their own. One more level of nesting changes
 * nothing about that.
 */

const PLAYER_SHELL_PATH = '/__player'

/** The URL to load in a player view, for a given provider URL. */
export function playerShellUrl(baseUrl: string, providerUrl: string): string {
  return `${baseUrl}${PLAYER_SHELL_PATH}?src=${encodeURIComponent(providerUrl)}`
}

function servePlayerShell(res: ServerResponse, src: string | null): void {
  // Only http(s), and only a URL that parses. The parameter arrives from this
  // app's own main process, but a shell that will frame whatever it is handed
  // is one bug away from being told to frame something else.
  let target: URL
  try {
    target = new URL(src ?? '')
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('scheme')
  } catch {
    res.writeHead(400).end('Bad player target')
    return
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Player</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  iframe { display: block; width: 100vw; height: 100vh; border: 0; }
</style>
</head><body>
<iframe src="${escapeAttribute(target.toString())}"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowfullscreen></iframe>
</body></html>`

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The shell must never be framed by anything itself.
    'X-Frame-Options': 'DENY',
  })
  res.end(html)
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function startRendererServer(rendererDir: string): Promise<string> {
  const root = normalize(rendererDir)

  return new Promise((resolve, reject) => {
    if (server) {
      const address = server.address()
      if (address && typeof address === 'object') {
        resolve(`http://127.0.0.1:${address.port}`)
        return
      }
    }

    const instance = createServer((req, res) => {
      void (async () => {
        try {
          // `req.url` is a path, not an absolute URL; the base is only there to
          // satisfy the parser and is discarded.
          const { pathname, searchParams } = new URL(req.url ?? '/', 'http://127.0.0.1')

          if (pathname === PLAYER_SHELL_PATH) {
            servePlayerShell(res, searchParams.get('src'))
            return
          }
          const requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
          const resolved = normalize(join(root, requested))

          if (resolved !== root && !resolved.startsWith(root + sep)) {
            res.writeHead(403).end('Forbidden')
            return
          }

          const info = await stat(resolved)
          if (!info.isFile()) {
            res.writeHead(404).end('Not found')
            return
          }

          res.writeHead(200, {
            'Content-Type': MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': info.size,
            // The bundle is rebuilt on every release and served locally, so
            // caching it buys nothing and can serve a stale build after an
            // update.
            'Cache-Control': 'no-store',
          })
          createReadStream(resolved).pipe(res)
        } catch {
          res.writeHead(404).end('Not found')
        }
      })()
    })

    instance.on('error', reject)

    // Port 0: let the OS pick. Host is explicit — binding the wildcard would
    // publish the UI to every interface on the machine.
    instance.listen(0, '127.0.0.1', () => {
      server = instance
      const address = instance.address()
      if (!address || typeof address !== 'object') {
        reject(new Error('renderer server started without an address'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/** Close the server. Called on quit so the port is released promptly. */
export function stopRendererServer(): void {
  server?.close()
  server = null
}
