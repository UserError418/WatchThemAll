/**
 * WatchThemAll — Electron main process
 *
 * Desktop application for navigating video embed pages, bookmarking
 * series, and tracking new episode releases. Ported from ReelVault
 * Chrome extension with full feature parity + desktop enhancements.
 *
 * Features:
 *   - Resizable management window (remembers size/position)
 *   - Dedicated embed player windows with edge navigation buttons
 *   - Application menu (File, Edit, View, Help)
 *   - Keyboard shortcuts for all tabs and common actions
 *   - Background watchlist checking with system notifications
 *   - System tray for quick access
 *   - JSON file storage (zero external dependencies)
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Chromium Flags (must be set before app.whenReady) ─────────
// Video playback: relaxed autoplay for HLS/DASH, hardware decode
// for GPU-accelerated playback (required by Nvidia RTX Video Super
// Resolution, which detects video frames on the GPU).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('disable-features', 'PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies');

const APP_NAME = 'WatchThemAll';
const APP_VERSION = app.getVersion();

// ── Browser Identity Spoofing ─────────────────────────────────
// Providers block requests with "Electron" in the User-Agent.
// We spoof a standard Chrome UA so all API calls (health probes,
// IMDB searches, TVmaze, TMDB, GitHub) look like regular Chrome.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function setupBrowserIdentity() {
  const ses = session.defaultSession;

  // Override User-Agent at the session level
  ses.setUserAgent(CHROME_UA);

  // Replace (don't strip) client hint headers with Chrome-appropriate values.
  // Real Chrome always sends Sec-CH-UA — missing headers are MORE suspicious
  // than Electron-branded ones. Providers check for this.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      // Replace with Chrome 138 values matching our spoofed UA
      details.requestHeaders['Sec-CH-UA'] = '"Chromium";v="138", "Google Chrome";v="138", "Not?A_Brand";v="99"';
      details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"';
      details.requestHeaders['Sec-CH-UA-Mobile'] = '?0';
      // Remove Electron-specific hints
      delete details.requestHeaders['Sec-CH-UA-Arch'];
      delete details.requestHeaders['Sec-CH-UA-Bitness'];
      delete details.requestHeaders['Sec-CH-UA-Full-Version'];
      delete details.requestHeaders['Sec-CH-UA-Full-Version-List'];
      delete details.requestHeaders['Sec-CH-UA-Model'];
      delete details.requestHeaders['Sec-CH-UA-Platform-Version'];
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

// Call after app is ready — session API requires it
let _identitySetup = false;
function ensureBrowserIdentity() {
  if (_identitySetup) return;
  _identitySetup = true;
  setupBrowserIdentity();
}

// ── JSON File Store ───────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DATA_FILE = path.join(DATA_DIR, 'watchthemall.json');

const DEFAULTS = {
  vidsrc_schemas: [],
  vidsrc_bookmarks: [],
  vidsrc_form_state: {},
  vidsrc_history: [],
  vidsrc_availability: {},
  vidsrc_active_providers: null,
  vidsrc_provider_catalog: null,
  vidsrc_provider_health: {},
  vidsrc_watchlist_items: [],
  vidsrc_watchlist_last_check: 0,
  vidsrc_watchlist_deleted: [],
};

let _store = null;

function loadStore() {
  if (_store) return _store;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      _store = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    } else {
      _store = { ...DEFAULTS };
      flushStore();
    }
  } catch (err) {
    console.error(`${APP_NAME}: failed to load store:`, err.message);
    _store = { ...DEFAULTS };
  }
  return _store;
}

function flushStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error(`${APP_NAME}: failed to flush store:`, err.message);
  }
}

// ── Window State ──────────────────────────────────────────────
const WIN_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return { width: 1024, height: 680, x: undefined, y: undefined };
}

function saveWindowState(win) {
  try {
    const bounds = win.getBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(bounds, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Window References ─────────────────────────────────────────
let mainWindow = null;
let tray = null;
const embedWindows = new Map();

// ── Background Watchlist Check ────────────────────────────────
let watchlistTimer = null;
const WATCHLIST_CHECK_INTERVAL = 60 * 60 * 1000; // every hour

async function runBackgroundWatchlistCheck() {
  // Skip if main window is open (popup handles its own check)
  if (mainWindow && !mainWindow.isDestroyed()) return;

  const store = loadStore();
  const items = store.vidsrc_watchlist_items || [];
  if (!items.length) return;

  // Find items with pending updates
  const pending = items.filter(w => w.hasUpdate);
  if (pending.length === 0) return;

  // Show notification
  const count = pending.length;
  const label = count === 1 ? pending[0].name : `${count} series`;
  try {
    const notif = new Notification({
      title: 'WatchThemAll — New Episodes',
      body: `${label} ${count === 1 ? 'has' : 'have'} new content available.`,
      urgency: 'normal',
    });
    notif.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      mainWindow.focus();
      mainWindow.webContents.send('navigate-tab', 'watchlist');
    });
    notif.show();
  } catch (_) { /* notifications may be disabled */ }
}

function startWatchlistTimer() {
  if (watchlistTimer) clearInterval(watchlistTimer);
  watchlistTimer = setInterval(runBackgroundWatchlistCheck, WATCHLIST_CHECK_INTERVAL);
  // Run once 10s after startup
  setTimeout(runBackgroundWatchlistCheck, 10000);
}

// ── Application Menu ──────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'New Bookmark',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu-action', 'new-bookmark'),
        },
        {
          label: 'New Watchlist Item',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu-action', 'new-watchlist'),
        },
        { type: 'separator' },
        {
          label: 'Export Data',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: async () => {
            const store = loadStore();
            const payload = {
              version: 1,
              exportedAt: new Date().toISOString(),
              data: {
                vidsrc_bookmarks: store.vidsrc_bookmarks || [],
                vidsrc_watchlist_items: store.vidsrc_watchlist_items || [],
                vidsrc_history: store.vidsrc_history || [],
                vidsrc_active_providers: store.vidsrc_active_providers || [],
                vidsrc_schemas: store.vidsrc_schemas || [],
              },
            };
            const json = JSON.stringify(payload, null, 2);
            const { filePath } = await dialog.showSaveDialog(mainWindow, {
              title: 'Export WatchThemAll Data',
              defaultPath: `watchthemall-${new Date().toISOString().slice(0,10)}.json`,
              filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (filePath) fs.writeFileSync(filePath, json, 'utf-8');
          },
        },
        { type: 'separator' },
        {
          label: 'Import Data',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: async () => {
            const { filePaths } = await dialog.showOpenDialog(mainWindow, {
              title: 'Import WatchThemAll Data',
              filters: [{ name: 'JSON', extensions: ['json'] }],
              properties: ['openFile'],
            });
            if (!filePaths || !filePaths.length) return;
            try {
              const raw = fs.readFileSync(filePaths[0], 'utf-8');
              const imported = JSON.parse(raw);
              const ok = await ipcMain.emit ? true : false;
              // Invoke the handler directly
              const result = await (async () => {
                if (!imported || !imported.data) return false;
                const store = loadStore();
                const { data } = imported;
                // ... same merge logic as import-data handler
                if (Array.isArray(data.vidsrc_bookmarks)) {
                  const ids = new Set((store.vidsrc_bookmarks||[]).map(b=>b.bookmarkId));
                  for (const bm of data.vidsrc_bookmarks) if (!ids.has(bm.bookmarkId)) { store.vidsrc_bookmarks.push(bm); ids.add(bm.bookmarkId); }
                }
                if (Array.isArray(data.vidsrc_watchlist_items)) {
                  const ids = new Set((store.vidsrc_watchlist_items||[]).map(w=>w.watchId));
                  for (const wl of data.vidsrc_watchlist_items) if (!ids.has(wl.watchId)) { store.vidsrc_watchlist_items.push(wl); ids.add(wl.watchId); }
                }
                if (Array.isArray(data.vidsrc_history)) {
                  const ids = new Set((store.vidsrc_history||[]).map(h=>h.historyId));
                  for (const h of data.vidsrc_history) if (!ids.has(h.historyId)) { store.vidsrc_history.push(h); ids.add(h.historyId); }
                }
                if (Array.isArray(data.vidsrc_schemas)) {
                  const ids = new Set((store.vidsrc_schemas||[]).map(s=>s.schemaId));
                  for (const s of data.vidsrc_schemas) if (!ids.has(s.schemaId)) { store.vidsrc_schemas.push(s); ids.add(s.schemaId); }
                }
                if (Array.isArray(data.vidsrc_active_providers)) {
                  const existing = new Set(store.vidsrc_active_providers || []);
                  for (const pid of data.vidsrc_active_providers) existing.add(pid);
                  store.vidsrc_active_providers = [...existing];
                }
                flushStore();
                return true;
              })();
              if (result && mainWindow) {
                mainWindow.webContents.send('data-imported');
              }
            } catch (err) {
              dialog.showErrorBox('Import Failed', err.message);
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Quit' },
      ],
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Providers',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('navigate-tab', 'schemas'),
        },
        {
          label: 'Bookmarks',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('navigate-tab', 'bookmarks'),
        },
        {
          label: 'Watchlist',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('navigate-tab', 'watchlist'),
        },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow?.webContents.send('navigate-tab', 'history'),
        },
        { type: 'separator' },
        { role: 'reload', label: 'Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    // Help
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: `Version ${APP_VERSION}\n\nCross-platform desktop app for navigating video embed pages, bookmarking series, and tracking new episode releases.\n\nPorted from the ReelVault browser extension.`,
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── IPC Handlers ──────────────────────────────────────────────

ipcMain.handle('storage:get', (_event, defaults) => {
  const store = loadStore();
  const result = {};
  for (const [key, defaultVal] of Object.entries(defaults)) {
    result[key] = (key in store) ? store[key] : defaultVal;
  }
  console.log('[WTA main] storage:get keys:', Object.keys(defaults), '→ returning', Object.keys(result).length, 'keys');
  return result;
});

ipcMain.handle('storage:set', (_event, obj) => {
  const store = loadStore();
  Object.assign(store, obj);
  flushStore();
  console.log('[WTA main] storage:set keys:', Object.keys(obj));
  return true;
});

ipcMain.handle('open-embed', (_event, url, meta) => {
  // Reuse window if exact same URL is already open
  const existing = embedWindows.get(url);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    existing.win.focus();
    return true;
  }

  embedWin = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'WatchThemAll — Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'embed-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,  // Required: video CDNs are cross-origin from player page
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Prevent background throttling from stalling video playback
  embedWin.webContents.setBackgroundThrottling(false);

  embedWin.loadURL(url);
  embedWin.show();
  embedWin.focus();

  // Store metadata for later episode tracking
  embedWindows.set(url, {
    win: embedWin,
    imdb: (meta && meta.imdb) || null,
    name: (meta && meta.name) || null,
  });

  // Handle load failures — show a reload prompt
  embedWin.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    if (errorCode === -3 || errorCode === -105 || errorCode === -106) return; // aborted/navigation, ignore
    try {
      embedWin.webContents.executeJavaScript(`
        if (document.body && !document.getElementById('wta-error-overlay')) {
          var d = document.createElement('div');
          d.id = 'wta-error-overlay';
          d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,0.85);color:#fff;font-family:system-ui,sans-serif;font-size:14px;text-align:center;padding:20px';
          d.innerHTML = '<div style="font-size:18px;font-weight:600">Failed to load player</div><div style="color:#999;font-size:12px">The embed provider may be unavailable</div><button onclick="location.reload()" style="padding:8px 24px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">Retry</button><button onclick="window.close()" style="padding:8px 24px;background:transparent;color:#999;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px">Close</button>';
          document.body.appendChild(d);
        }
      `).catch(() => {});
    } catch (_) {}
  });

  // Block ALL popups from player windows — no ads, no popups.
  embedWin.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  embedWin.on('closed', () => {
    embedWindows.delete(url);
  });

  return true;
});

// Handle episode change reports from embed player windows
ipcMain.on('embed:episode-changed', (event, data) => {
  // Find the embed window's metadata by iterating the Map
  for (const [embedUrl, entry] of embedWindows) {
    if (entry.win && entry.win.webContents && entry.win.webContents.id === event.sender.id) {
      if (entry.imdb && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('episode-watched', {
          imdb: entry.imdb,
          name: entry.name || '',
          season: data.season,
          episode: data.episode,
        });
      }
      break;
    }
  }
});

ipcMain.handle('read-providers-json', () => {
  const filePath = path.join(__dirname, 'src', 'providers.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
});

// export-data — returns all data as JSON in shared sync format
ipcMain.handle('export-data', () => {
  const store = loadStore();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      vidsrc_bookmarks: store.vidsrc_bookmarks || [],
      vidsrc_watchlist_items: store.vidsrc_watchlist_items || [],
      vidsrc_history: store.vidsrc_history || [],
      vidsrc_active_providers: store.vidsrc_active_providers || [],
      vidsrc_schemas: store.vidsrc_schemas || [],
    },
  };
  return payload;
});

// import-data — merges imported data into the store
ipcMain.handle('import-data', (_event, imported) => {
  const store = loadStore();
  if (!imported || !imported.data) return false;

  const { data } = imported;

  // Merge bookmarks by bookmarkId
  if (Array.isArray(data.vidsrc_bookmarks)) {
    const existingIds = new Set((store.vidsrc_bookmarks || []).map(b => b.bookmarkId));
    for (const bm of data.vidsrc_bookmarks) {
      if (!existingIds.has(bm.bookmarkId)) {
        store.vidsrc_bookmarks.push(bm);
        existingIds.add(bm.bookmarkId);
      }
    }
  }

  // Merge watchlist by watchId
  if (Array.isArray(data.vidsrc_watchlist_items)) {
    const existingIds = new Set((store.vidsrc_watchlist_items || []).map(w => w.watchId));
    for (const wl of data.vidsrc_watchlist_items) {
      if (!existingIds.has(wl.watchId)) {
        store.vidsrc_watchlist_items.push(wl);
        existingIds.add(wl.watchId);
      }
    }
  }

  // Merge history by historyId
  if (Array.isArray(data.vidsrc_history)) {
    const existingIds = new Set((store.vidsrc_history || []).map(h => h.historyId));
    for (const h of data.vidsrc_history) {
      if (!existingIds.has(h.historyId)) {
        store.vidsrc_history.push(h);
        existingIds.add(h.historyId);
      }
    }
  }

  // Merge schemas by schemaId
  if (Array.isArray(data.vidsrc_schemas)) {
    const existingIds = new Set((store.vidsrc_schemas || []).map(s => s.schemaId));
    for (const s of data.vidsrc_schemas) {
      if (!existingIds.has(s.schemaId)) {
        store.vidsrc_schemas.push(s);
        existingIds.add(s.schemaId);
      }
    }
  }

  // Merge active providers (unique)
  if (Array.isArray(data.vidsrc_active_providers)) {
    const existing = new Set(store.vidsrc_active_providers || []);
    for (const pid of data.vidsrc_active_providers) {
      existing.add(pid);
    }
    store.vidsrc_active_providers = [...existing];
  }

  flushStore();
  return true;
});

// get-data-dir — returns the data directory path (for UI footer)
ipcMain.handle('get-data-dir', () => {
  return DATA_DIR;
});

// ── Video Downloader ──────────────────────────────────────────
const https = require('https');
const http = require('http');

// ── Recommendation Engine ─────────────────────────────────────
const { RecommendationEngine } = require('./src/recommendations.js');

ipcMain.handle('get-recommendations', async (_event, userData) => {
  try {
    const engine = new RecommendationEngine(userData, DATA_DIR);
    if (userData.forceRefresh) {
      try { fs.unlinkSync(engine.cacheFile); } catch (_) {}
    }
    return await engine.getRecommendations();
  } catch (e) {
    return { rows: [], profile: null, error: e.message, cached: false };
  }
});

ipcMain.handle('get-more-recommendations', async (_event, { userData, count }) => {
  try {
    const engine = new RecommendationEngine(userData, DATA_DIR);
    return await engine.getMoreRecommendations(count || 20);
  } catch (e) {
    return { shows: [], category: '', hasMore: false };
  }
});

const activeDownloads = new Map();

function fetchText(u) {
  return new Promise((res, rej) => {
    const get = u.startsWith('https') ? https.get : http.get;
    get(u, { headers: { 'User-Agent': CHROME_UA } }, (resp) => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    }).on('error', rej);
  });
}

function parseSegments(text, base) {
  const segs = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      try { segs.push(new URL(t, base).toString()); }
      catch (_) { segs.push(base.replace(/[^/]+$/, '') + t); }
    }
  }
  return segs;
}

function dlSeg(url, retries = 3) {
  return new Promise((res, rej) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': CHROME_UA } }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', (err) => {
      if (retries > 0) setTimeout(() => dlSeg(url, retries - 1).then(res).catch(rej), 600);
      else rej(err);
    });
  });
}

function sendProgress(downloadId, stage, current, total, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', { downloadId, stage, current, total, ...(extra || {}) });
  }
}

ipcMain.handle('download-video', (event, { url, imdb, name, season, episode }) => {
  const downloadId = Date.now().toString(36);
  const outputDir = path.join(app.getPath('downloads'), 'WatchThemAll');
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = (name || 'video').replace(/[/\\?%*:|"<>]/g, '_');
  const posLabel = season ? `.S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : '';
  const outputFile = path.join(outputDir, `${safeName}${posLabel}.ts`);

  (async () => {
    const dlWin = new BrowserWindow({
      width: 1280, height: 720, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    dlWin.webContents.setBackgroundThrottling(false);
    dlWin.setMenuBarVisibility(false);
    activeDownloads.set(downloadId, { win: dlWin });

    const manifestUrls = []; // collect ALL .m3u8 URLs, try each
    let resolved = false;
    const filter = (details, callback) => {
      if (!resolved && details.url.includes('.m3u8') && !manifestUrls.includes(details.url)) {
        manifestUrls.push(details.url);
      }
      callback({ cancel: false });
    };
    dlWin.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*.m3u8*', '*://*/*.mpd*'] }, filter);

    dlWin.loadURL(url);

    // Show window immediately — user must click play to start the stream
    dlWin.show();
    dlWin.focus();
    sendProgress(downloadId, 'waiting', 0, 0, { name: safeName });

    try {
      // Wait for stream to start (user clicks play → manifest URLs appear)
      await new Promise((resolveWait) => {
        const mc = setInterval(() => {
          if (manifestUrls.length > 0) {
            clearInterval(mc);
            resolved = true;
            if (dlWin && !dlWin.isDestroyed()) dlWin.hide();
            resolveWait();
          }
        }, 1000);
        // Give up after 2 minutes
        setTimeout(() => { clearInterval(mc); if (!resolved) resolveWait(); }, 120000);
      });

      if (!manifestUrls.length) { sendProgress(downloadId, 'error', 0, 0); return; }

      // Try each manifest URL until we find one with segments.
      // If a manifest has no segments but is a master playlist, try its variants.
      let segments = [];
      sendProgress(downloadId, 'manifest', 0, 0, { name: safeName });

      for (const murl of manifestUrls) {
        try {
          const text = await fetchText(murl);
          let se = parseSegments(text, murl);

          // If no direct segments, check for master playlist with variants
          if (!se.length && text.includes('#EXT-X-STREAM-INF')) {
            const variants = [];
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('BANDWIDTH=') && i + 1 < lines.length) {
                const next = lines[i + 1].trim();
                if (next && !next.startsWith('#')) {
                  try { variants.push(new URL(next, murl).toString()); }
                  catch (_) { variants.push(murl.replace(/[^/]+$/, '') + next); }
                }
              }
            }
            // Try each variant
            for (const vurl of variants) {
              try {
                const vt = await fetchText(vurl);
                const vs = parseSegments(vt, vurl);
                if (vs.length) { segments = vs; break; }
              } catch (_) {}
            }
          } else {
            segments = se;
          }

          if (segments.length) break; // found good segments
        } catch (_) { /* try next URL */ }
      }

      if (!segments.length) { sendProgress(downloadId, 'error', 0, 0); return; }

      // Recursive segment downloader — handles sub-playlists with concurrency
      async function dlRecursive(url, depth) {
        if (depth === undefined) depth = 0;
        if (depth > 3) return Buffer.alloc(0);
        const data = await dlSeg(url);
        // Check if this is a sub-playlist (starts with #EXTM3U)
        if (data.length > 0 && data.slice(0, 7).toString() === '#EXTM3U') {
          const text = data.toString();
          const subSegs = parseSegments(text, url);
          if (!subSegs.length) return Buffer.alloc(0);
          // Parallel download of sub-playlist segments (same concurrency)
          const parts = new Array(subSegs.length);
          let si = 0;
          await Promise.all(Array.from({ length: 4 }, async () => {
            while (si < subSegs.length) {
              const i = si++;
              try { parts[i] = await dlRecursive(subSegs[i], depth + 1); }
              catch (_) { parts[i] = Buffer.alloc(0); }
            }
          }));
          return Buffer.concat(parts);
        }
        return data;
      }

      sendProgress(downloadId, 'downloading', 0, segments.length, { name: safeName });
      const totalSegs = segments.length;
      const results = [];
      // Download all outer segments (which may expand via sub-playlists)
      let idx = 0, done = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (idx < totalSegs) {
          const i = idx++;
          try { results[i] = await dlRecursive(segments[i]); }
          catch (_) { results[i] = Buffer.alloc(0); }
          done++;
          sendProgress(downloadId, 'downloading', done, totalSegs, { name: safeName });
        }
      }));

      sendProgress(downloadId, 'merging', 0, 1, { name: safeName });
      const valid = results.filter(b => b.length > 0);
      const failed = results.length - valid.length;
      const totalSize = valid.reduce((s, b) => s + b.length, 0);
      fs.writeFileSync(outputFile, Buffer.concat(valid));
      sendProgress(downloadId, 'complete', valid.length, segments.length, { name: safeName, failed, sizeMB: (totalSize / 1048576).toFixed(1) });
    } catch (err) {
      sendProgress(downloadId, 'error', 0, 0);
    } finally {
      if (dlWin && !dlWin.isDestroyed()) dlWin.close();
      activeDownloads.delete(downloadId);
    }
  })();

  return { downloadId };
});

ipcMain.on('cancel-download', (_event, downloadId) => {
  const entry = activeDownloads.get(downloadId);
  if (entry) { try { if (entry.win && !entry.win.isDestroyed()) entry.win.close(); } catch (_) {} activeDownloads.delete(downloadId); }
});

// ── Window Creation ───────────────────────────────────────────
function createMainWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 780,
    minHeight: 550,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'main-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'app.html'));

  // Block ALL popups from the main window — embed windows are
  // only opened via the open-embed IPC handler.
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App Lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  ensureBrowserIdentity();
  loadStore();
  buildMenu();
  createMainWindow();
  startWatchlistTimer();

  // Global safety net: close any untracked window immediately.
  // Only the main window and embed windows (opened via open-embed IPC)
  // are allowed to exist. Ads sometimes find ways to spawn windows
  // that bypass per-webContents handlers.
  // DISABLED for debugging player click issues
  /*
  app.on('browser-window-created', (_event, win) => {
    setImmediate(() => {
      if (win === mainWindow) return;
      let found = false;
      for (const [url, ew] of embedWindows) {
        if (ew === win) { found = true; break; }
      }
      if (!found && !win.isDestroyed()) {
        win.close();
      }
    });
  });
  */

  // System tray (optional — can be disabled from settings)
  try {
    tray = new Tray(path.join(__dirname, 'icons', 'icon16.png'));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
        mainWindow.focus();
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      mainWindow.focus();
    });
  } catch (_) { /* tray icon may fail on some Linux DEs */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (watchlistTimer) clearInterval(watchlistTimer);
});
