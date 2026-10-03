import { expect, it } from 'vitest'
import { PLAYER_ACTIONS } from '@shared/playerkeys'
import { routePlayerAction, type PlayerActionHandlers } from './playeraction'

function recorder() {
  const done: string[] = []
  const handlers: PlayerActionHandlers = {
    transport: (action) => done.push(`transport:${action}`),
    fullscreen: () => done.push('fullscreen'),
    openPanel: (panel) => done.push(`panel:${panel}`),
    shrink: () => done.push('shrink'),
    reload: () => done.push('reload'),
  }
  return { done, handlers }
}

it('gives every key on the page something to do, apart from Back and Escape', () => {
  const { done, handlers } = recorder()
  for (const action of PLAYER_ACTIONS) routePlayerAction(action, 'keys', handlers)

  expect(done).toEqual([
    'transport:togglePlay',
    'transport:seekBack',
    'transport:seekForward',
    'transport:volumeUp',
    'transport:volumeDown',
    'transport:mute',
    'panel:episodes',
    'panel:cast',
    'reload',
    'fullscreen',
    'panel:sources',
  ])
})

it('shrinks the player on Back or Escape from our overlay only', () => {
  const { done, handlers } = recorder()

  routePlayerAction('escape', 'keys', handlers)
  routePlayerAction('back', 'keys', handlers)
  routePlayerAction('escape', 'overlay', handlers)
  routePlayerAction('back', 'overlay', handlers)

  expect(done).toEqual(['shrink', 'shrink'])
})
