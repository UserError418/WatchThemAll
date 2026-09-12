<script lang="ts">
  /**
   * Cross-device sync, in the Settings panel.
   *
   * The whole screen is one status object pushed from main, which is why there
   * is no local state to keep in step here: the interesting moments — a code
   * appearing, the user finishing at Google, a sync completing — all originate
   * over there and none of them are on a schedule this component could poll.
   *
   * The code screen is the part worth getting right. It is the only moment the
   * user has to carry something from this device to another one, so the code is
   * large, spaced, and selectable, and the address sits directly under it.
   */
  import { timeAgo } from '@/lib/format'
  import type { SyncStatus } from '@shared/sync/types'

  let status = $state<SyncStatus>({
    state: 'off',
    accountEmail: null,
    lastSyncedAt: null,
    error: null,
    challenge: null,
  })

  /**
   * Ticks once a second, and only while a code is on screen.
   *
   * The expiry countdown is the one thing here that changes without main
   * saying so. Everything else is push-driven, so a permanent interval would be
   * a timer running all evening to redraw nothing.
   */
  let now = $state(Date.now())

  $effect(() => {
    void window.wta.sync.status().then((initial) => (status = initial))
    return window.wta.on.syncStatus((next) => (status = next))
  })

  $effect(() => {
    if (status.state !== 'pairing') return
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  const expiresIn = $derived.by(() => {
    if (status.challenge === null) return ''
    const seconds = Math.max(0, Math.round((status.challenge.expiresAt - now) / 1000))
    const minutes = Math.floor(seconds / 60)
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  })

  /** The address without its scheme — shorter to read, and shorter to retype. */
  const verificationHost = $derived(
    status.challenge?.verificationUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? '',
  )
</script>

<section class="sync">
  <h3>Sync across your devices</h3>

  {#if status.state === 'pairing' && status.challenge}
    <p class="lead">On any other device, open</p>
    <p class="url">{verificationHost}</p>
    <p class="lead">and enter this code:</p>
    <p class="code">{status.challenge.userCode}</p>
    <p class="hint">
      {#if expiresIn === '0:00'}
        This code has expired — start again.
      {:else}
        Expires in {expiresIn}. Waiting…
      {/if}
    </p>
    <div class="actions">
      <button onclick={() => window.wta.sync.cancel()}>Cancel</button>
    </div>
  {:else if status.accountEmail !== null || status.state === 'syncing' || status.state === 'idle'}
    <p class="account">{status.accountEmail ?? 'Connected'}</p>
    <p class="hint">
      {#if status.state === 'syncing'}
        Syncing…
      {:else if status.lastSyncedAt !== null}
        Last synced {timeAgo(status.lastSyncedAt)}.
      {:else}
        Not synced yet.
      {/if}
    </p>
    <div class="actions">
      <button
        class="primary"
        disabled={status.state === 'syncing'}
        onclick={() => window.wta.sync.now()}>Sync now</button
      >
      <button onclick={() => window.wta.sync.disconnect()}>Disconnect</button>
    </div>
  {:else}
    <p class="hint">
      Keep your library the same on your desktop and your phone. Sign in the way
      you would sign a TV into YouTube — a short code, typed on a device you are
      already signed in on.
    </p>
    <p class="hint">
      Your library is saved to your own Google&nbsp;Drive, as a file you can see
      and delete. It never passes through any server of ours, and this app
      cannot see anything else in your Drive &mdash; your other files are not
      just off&#8209;limits to it, they are invisible to it.
    </p>
    <div class="actions">
      <button class="primary" onclick={() => window.wta.sync.connect()}>
        Connect a Google account
      </button>
    </div>
  {/if}

  {#if status.error !== null}
    <p class="error" role="alert">{status.error}</p>
  {/if}
</section>

<style>
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .hint,
  .lead {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .lead {
    margin-top: var(--space-1);
  }

  .account {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-primary);
    /* An address is arbitrarily long and the panel is 380px. */
    overflow-wrap: anywhere;
  }

  /*
    The code is the whole point of this screen: it is read off one device and
    typed into another, so it is set large, widely tracked and monospaced —
    the three things that stop a 0 being read as an O.
  */
  .code {
    margin: var(--space-1) 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: var(--accent);
    /* Selectable, because retyping is not the only way to move it. */
    user-select: all;
  }

  .url {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    user-select: all;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  button {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    font: inherit;
    font-size: var(--text-xs);
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  button.primary {
    color: var(--text-on-accent);
    background: var(--accent);
    border-color: transparent;
  }

  button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--danger, #f87171);
  }
</style>
