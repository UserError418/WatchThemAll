import { mount } from 'svelte'
import App from './App.svelte'
import { scan } from './lib/scan.svelte'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/global.css'

/**
 * Subscribed before the app mounts, and never unsubscribed.
 *
 * A scan outlives the component that started it — the user begins one in the
 * detail view and presses play while it runs — so the subscription cannot live
 * in either surface's lifecycle without dropping the rest of the run.
 */
scan.listen()

mount(App, { target: document.getElementById('app')! })
