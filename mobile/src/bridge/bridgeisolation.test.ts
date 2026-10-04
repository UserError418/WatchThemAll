import { expect, it } from 'vitest'
import { checkBridgeIsolation } from './bridgeisolation'

it('reports a WebView that hands its bridge to every frame', async () => {
  expect(await checkBridgeIsolation({ bridgeIsolated: async () => ({ isolated: false }) })).toBe(false)
  expect(await checkBridgeIsolation({ bridgeIsolated: async () => ({ isolated: true }) })).toBe(true)
})

it('counts a plugin that cannot answer as isolated, as in the browser preview', async () => {
  const missing = {
    bridgeIsolated: async (): Promise<{ isolated: boolean }> => {
      throw new Error('"PlayerRelay" plugin is not implemented on web')
    },
  }

  expect(await checkBridgeIsolation(missing)).toBe(true)
})
