/**
 * Entry point for the player chrome overlay.
 *
 * Deliberately separate from `main.ts`: this document is mounted into its own
 * `WebContentsView`, stacked above the video, and shares no state with the app
 * window. What it needs arrives over IPC — see `chrome.html` for why it cannot
 * simply be part of the app's page.
 */

import { mount } from 'svelte'
import PlayerChrome from './PlayerChrome.svelte'
import SkipOffer from './SkipOffer.svelte'

const target = document.getElementById('chrome')
if (target === null) throw new Error('chrome.html is missing its mount point')

/**
 * One document, two views, chosen by the URL.
 *
 * The player lays two transparent views over the video — the bar across the
 * top and the skip button in the bottom-right corner — because a view
 * swallows every mouse event inside its bounds and so must be sized to
 * exactly what it draws. They share this entry point rather than having two
 * of everything: the preload, the CSP and the build input are identical, and
 * the only difference is which component is mounted.
 */
const role = new URLSearchParams(window.location.search).get('role')

export default mount(role === 'skip' ? SkipOffer : PlayerChrome, { target })
