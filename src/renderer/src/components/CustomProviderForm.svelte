<script lang="ts">
  /**
   * Add a custom embed provider.
   *
   * Providers change domain constantly, so being able to add one without
   * waiting for an app release is the difference between the app working and
   * not. The original had this and it is worth keeping.
   *
   * The form previews the URL it will build as you type. A template is easy to
   * get subtly wrong — a missing slash, the wrong placeholder — and the failure
   * otherwise surfaces much later as a blank player window.
   */
  import type { Provider } from '@shared/types'
  import { library } from '../lib/library.svelte'

  interface Props {
    oncancel: () => void
    onsaved: () => void
  }

  const { oncancel, onsaved }: Props = $props()

  let name = $state('')
  let rootUrl = $state('https://')
  let tvTemplate = $state('{rootUrl}tv/{imdb}/{season}/{episode}')
  let movieTemplate = $state('{rootUrl}movie/{imdb}')
  let error = $state<string | null>(null)

  /** A worked example, so the preview shows something recognisable. */
  const SAMPLE = { imdb: 'tt0903747', tmdb: '1396', season: '2', episode: '5' }

  function render(template: string): string | null {
    if (!template.trim()) return null
    const root = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`
    const url = template
      .replaceAll('{rootUrl}', root)
      .replaceAll('{imdb}', SAMPLE.imdb)
      .replaceAll('{tmdb}', SAMPLE.tmdb)
      .replaceAll('{season}', SAMPLE.season)
      .replaceAll('{episode}', SAMPLE.episode)
      .replace(/([^:])\/\//g, '$1/')
      .replace(/\/\?/g, '?')
    try {
      return new URL(url).toString()
    } catch {
      return null
    }
  }

  const tvPreview = $derived(render(tvTemplate))
  const moviePreview = $derived(render(movieTemplate))

  function save(): void {
    error = null

    if (!name.trim()) {
      error = 'Give the provider a name.'
      return
    }
    try {
      new URL(rootUrl)
    } catch {
      error = 'The root URL is not a valid URL.'
      return
    }
    if (!tvTemplate.trim() && !movieTemplate.trim()) {
      error = 'Fill in at least one template — TV or film.'
      return
    }
    if (tvTemplate.trim() && !tvPreview) {
      error = 'The TV template does not produce a valid URL.'
      return
    }
    if (movieTemplate.trim() && !moviePreview) {
      error = 'The film template does not produce a valid URL.'
      return
    }

    // Slug from the name, made unique — the id is what the store and the
    // export format key on, so a collision would silently shadow a provider.
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'provider'
    let id = `custom-${base}`
    let suffix = 2
    while (library.providers.some((p) => p.id === id)) id = `custom-${base}-${suffix++}`

    const provider: Provider = {
      id,
      name: name.trim(),
      rootUrl: rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`,
      tv: tvTemplate.trim() ? { urlTemplate: tvTemplate.trim() } : null,
      movie: movieTemplate.trim() ? { urlTemplate: movieTemplate.trim() } : null,
      tier: 'extras',
    }

    library.addCustomProvider(provider)
    onsaved()
  }
</script>

<form
  class="form"
  onsubmit={(e) => {
    e.preventDefault()
    save()
  }}
>
  <label>
    <span>Name</span>
    <input bind:value={name} placeholder="My Provider" />
  </label>

  <label>
    <span>Root URL</span>
    <input bind:value={rootUrl} placeholder="https://example.com/embed/" />
  </label>

  <label>
    <span>TV template</span>
    <input bind:value={tvTemplate} spellcheck="false" />
  </label>
  {#if tvTemplate.trim()}
    <p class="preview" class:bad={!tvPreview}>
      {tvPreview ?? 'Does not produce a valid URL'}
    </p>
  {/if}

  <label>
    <span>Film template</span>
    <input bind:value={movieTemplate} spellcheck="false" />
  </label>
  {#if movieTemplate.trim()}
    <p class="preview" class:bad={!moviePreview}>
      {moviePreview ?? 'Does not produce a valid URL'}
    </p>
  {/if}

  <p class="help">
    Placeholders: <code>{'{rootUrl}'}</code> <code>{'{imdb}'}</code>
    <code>{'{tmdb}'}</code> <code>{'{season}'}</code> <code>{'{episode}'}</code>. Leave a template
    empty if the provider does not serve that type.
  </p>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="actions">
    <button type="submit" class="primary">Add provider</button>
    <button type="button" onclick={oncancel}>Cancel</button>
  </div>
</form>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    margin: 0 var(--space-2) var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-base);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  label span {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  input {
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--text-sm);
    -webkit-user-select: text;
    user-select: text;
  }

  input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .preview {
    margin: 0 0 var(--space-1);
    font-size: 10px;
    color: var(--success);
    word-break: break-all;
  }

  .preview.bad {
    color: var(--danger);
  }

  .help {
    margin: var(--space-1) 0 0;
    font-size: 10px;
    line-height: 1.6;
    color: var(--text-tertiary);
  }

  code {
    padding: 0 3px;
    border-radius: 2px;
    background: var(--bg-elevated);
    font-size: 10px;
  }

  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .actions button {
    flex: 1;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .actions .primary {
    background: var(--accent);
    color: var(--text-on-media);
    font-weight: 600;
  }

  .actions .primary:hover {
    background: var(--accent-hover);
  }
</style>
