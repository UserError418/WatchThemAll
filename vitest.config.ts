import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

export default defineConfig({
  /**
   * The Svelte plugin is here so `.svelte.ts` modules are testable.
   *
   * Runes are compiler syntax, not runtime functions — an untransformed
   * `$state` is a bare identifier and throws `$state is not defined` at import
   * time. Without this, the reactive stores are the one part of the app that
   * cannot be unit-tested, which is precisely where the worst bug of the last
   * cycle lived (a `$state` array returning its raw target instead of the
   * proxy, so mutations persisted but never re-rendered).
   */
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: { '@shared': resolve('src/shared') },
    // Svelte's browser build is what the runes runtime lives in; the default
    // node condition resolves to a server build with no reactivity.
    conditions: ['browser'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['src/**/*.ts'] },
  },
})
