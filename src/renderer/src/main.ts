import { mount } from 'svelte'
import App from './App.svelte'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/global.css'

mount(App, { target: document.getElementById('app')! })
