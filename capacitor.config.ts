import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The Android app is the same Svelte renderer as the desktop app, wrapped in a
 * WebView. See `mobile/README.md` for how the two share source.
 *
 * `android.path` keeps the generated Gradle project inside `mobile/` rather
 * than at the repo root, where it would sit alongside `src/` and read as a
 * peer of the desktop app rather than as part of the phone build.
 */
const config: CapacitorConfig = {
  appId: 'net.watchthemall.app',
  appName: 'WatchThemAll',
  webDir: 'out/mobile',
  android: { path: 'mobile/android' },
  plugins: {
    /**
     * Route `fetch` and `XMLHttpRequest` through the native HTTP stack.
     *
     * This is what lets the business layer be reused verbatim. In a WebView the
     * page is served from `https://localhost`, so every TMDB and IMDB call is
     * cross-origin — TMDB sends permissive CORS headers but IMDB's suggestion
     * endpoint does not, and federated search is the only path that reaches the
     * IMDB ids providers key on. Patching fetch to go native removes the
     * browser's same-origin check from the equation entirely.
     */
    CapacitorHttp: { enabled: true },

    /**
     * Light icons in the status and gesture bars, always.
     *
     * Capacitor's default is `DEFAULT`, which means "follow the system theme" —
     * so a phone in light mode got *dark* icons drawn over an app that has no
     * light theme and never will, and the clock at the top of the screen was
     * black on black. The renderer is dark by construction (`tokens.css` has
     * one palette), so the bars can say so unconditionally.
     *
     * `DARK` here names the *background* the icons sit on, not the icons: it
     * maps to `setAppearanceLightStatusBars(false)`, i.e. light icons.
     */
    SystemBars: { style: 'DARK' },
  },
  server: {
    // Required for the native HTTP bridge to treat the app as a secure origin.
    androidScheme: 'https',
  },
}

export default config
