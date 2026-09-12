import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

/**
 * The phone build.
 *
 * Deliberately a *second config over the same sources*, not a second copy of
 * the app. `src/renderer` and `src/shared` are used unmodified; the only thing
 * that differs is the entry point, which installs a `window.wta` backed by
 * Capacitor instead of by Electron IPC.
 *
 * That works because the renderer's entire contact with the platform is the
 * `WtaApi` interface in `@shared/ipc` — 26 methods and a handful of event
 * subscriptions. Eighteen renderer files call it and none of them care which
 * implementation answers.
 */
export default defineConfig(({ mode }) => {
  // Same untracked `.env` as the desktop build, read from the repository root
  // rather than from `mobile/`, so one file configures both ports.
  const env = loadEnv(mode, resolve(__dirname, '..'), 'WTA_')

  return {
  root: resolve(__dirname),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@': resolve(__dirname, '../src/renderer/src'),
      // The business layer lives under src/main because that is where it runs
      // on desktop. None of the modules the phone build imports touch Node or
      // Electron — see mobile/README.md for the list and why it holds.
      '@main': resolve(__dirname, '../src/main'),
    },
  },
  define: {
    __WTA_GOOGLE_CLIENT_ID__: JSON.stringify(env.WTA_GOOGLE_CLIENT_ID ?? ''),
    __WTA_GOOGLE_CLIENT_SECRET__: JSON.stringify(env.WTA_GOOGLE_CLIENT_SECRET ?? ''),
  },
  plugins: [svelte({ configFile: resolve(__dirname, '../svelte.config.js') })],
  build: {
    outDir: resolve(__dirname, '../out/mobile'),
    emptyOutDir: true,
    // Android WebView on the minSdk this app targets is Chromium 90+, which
    // supports everything Vite's default target emits.
    target: 'es2022',
  },
}
})
