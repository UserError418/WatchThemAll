import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

/**
 * Three build targets. Main and preload are bundled for Node/Electron; the
 * renderer is a normal Vite SPA rooted at src/renderer.
 *
 * `@shared` resolves for all three so the IPC contract and domain types are
 * imported the same way on both sides of the process boundary.
 */
const shared = { '@shared': resolve('src/shared') }

/**
 * The OAuth client for sync, substituted into every bundle that can reach it.
 *
 * Read from an untracked `.env` rather than committed, because GitHub scans
 * public repositories for Google client secrets and can have them revoked
 * automatically — see `src/shared/sync/credentials.ts`. Absent is a supported
 * state: the app builds, and Settings explains that sync is off in this build.
 *
 * `JSON.stringify` rather than bare interpolation: a `define` value is
 * substituted as source text, so an unquoted secret would be compiled as an
 * identifier and fail at build time in a thoroughly confusing way.
 */
function syncClientDefines(mode: string): Record<string, string> {
  const env = loadEnv(mode, resolve('.'), 'WTA_')
  return {
    __WTA_GOOGLE_CLIENT_ID__: JSON.stringify(env.WTA_GOOGLE_CLIENT_ID ?? ''),
    __WTA_GOOGLE_CLIENT_SECRET__: JSON.stringify(env.WTA_GOOGLE_CLIENT_SECRET ?? ''),
  }
}


export default defineConfig(({ mode }) => ({
  main: {
    resolve: { alias: shared },
    define: syncClientDefines(mode),
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // Three preloads: the app bridge, the minimal one injected into
        // untrusted player windows, and the one behind the floating chrome.
        // They must not share a bundle — the player's runs inside a hostile
        // page and exposes nothing.
        input: {
          index: resolve('src/preload/index.ts'),
          player: resolve('src/preload/player.ts'),
          chrome: resolve('src/preload/chrome.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [svelte({ configFile: resolve('svelte.config.js') })],
    build: {
      // Resolved from the project root, not the renderer root — otherwise it
      // lands in src/renderer/out and gets picked up as source.
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        /*
          Two documents, not one.

          `chrome.html` is the player's floating controls. It has to be its own
          entry because it is mounted into a separate WebContentsView stacked
          above the video — the app's own page cannot paint over a child view.
        */
        input: {
          index: resolve('src/renderer/index.html'),
          chrome: resolve('src/renderer/chrome.html'),
        },
      },
    },
  },
}))
