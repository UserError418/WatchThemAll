/**
 * Open the phone bundle in a phone-sized window, for layout checks.
 *
 * There is no Chromium on this machine and no Android emulator, but Electron
 * *is* Chromium — so pointing a correctly-sized BrowserWindow at the built
 * mobile bundle gives a real render of the real CSS, inspectable over CDP the
 * same way the desktop app is.
 *
 *     npm run build:mobile
 *     node scripts/preview-mobile.cjs            # serves out/mobile
 *     python3 scripts/cdp.py --port 9540 --screenshot /tmp/phone.png '1'
 *
 * ## What this does and does not prove
 *
 * It proves layout, typography, the token overrides, and that the bridge's
 * pure-JavaScript half works — the store, provider ordering, MAL parsing and
 * every TMDB call.
 *
 * It does not prove anything native. Capacitor's plugins fall back to web
 * implementations here (Filesystem becomes IndexedDB, StatusBar throws and is
 * caught), and `CapacitorHttp` does not patch `fetch`, so requests are subject
 * to the browser's CORS rules. TMDB sends permissive headers and works; IMDB's
 * suggestion endpoint does not and will fail here while working on a device.
 * A failure in federated search seen only in this preview is expected.
 */

const { app, BrowserWindow } = require('electron')

/**
 * Match the WebView's autoplay policy.
 *
 * Capacitor's Bridge calls `setMediaPlaybackRequiresUserGesture(false)`, so a
 * muted trailer starts on its own on a device. Electron does not, and without
 * this the preview shows YouTube's large play overlay across the detail sheet's
 * header — which looks exactly like a layout bug and is not one.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const { createServer } = require('node:http')
const { readFile } = require('node:fs/promises')
const { join, extname, normalize } = require('node:path')

const ROOT = join(__dirname, '..', 'out', 'mobile')
const PORT = 5199

/** A Pixel-class portrait viewport; the layout's tightest realistic target. */
const VIEWPORT = { width: 412, height: 915 }

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = createServer(async (req, res) => {
  // `normalize` collapses any `..` before the join, so a crafted path cannot
  // read outside the bundle. This serves on loopback only, but a traversal in
  // a dev server is still a traversal.
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const path = join(ROOT, rel === '/' ? 'index.html' : rel)
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Single-page app: anything unresolved is a route, not a missing file.
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(await readFile(join(ROOT, 'index.html')))
  }
})

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    const win = new BrowserWindow({
      ...VIEWPORT,
      // The chrome would otherwise eat into the height and shift every
      // viewport-relative measurement in the layout.
      frame: false,
      backgroundColor: '#0a0a0f',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    void win.loadURL(`http://127.0.0.1:${PORT}/`)
  })
})

app.on('window-all-closed', () => app.quit())
