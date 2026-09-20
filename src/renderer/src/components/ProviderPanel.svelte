<script lang="ts">
  /**
   * Provider settings.
   *
   * Providers are embed sites, and they go down, change domain, or start
   * blocking non-browser clients constantly. The order here IS the order
   * Automatic tries them in — drag a row to change it — so making it visible
   * and reorderable is the difference between "the app is broken" and "try the
   * next one".
   *
   * The original probed every provider's origin with a HEAD request at startup
   * — dozens of concurrent requests to embed sites before the user had asked
   * for anything, each writing the whole store back to disk. That is gone. If a
   * provider fails, the player window says so and the user picks another.
   */
  import { library } from '../lib/library.svelte'
  import CustomProviderForm from './CustomProviderForm.svelte'
  import type { Provider } from '@shared/types'
  import { SvelteSet } from 'svelte/reactivity'
  import { panelIn, panelOut } from '../lib/motion'
  import { canHover } from '../lib/pointer'

  interface Props {
    onclose: () => void
  }

  const { onclose }: Props = $props()

  let adding = $state(false)

  const active = $derived(new Set(library.activeProviderIds))

  /**
   * Mirrors collapse into one row.
   *
   * Several of these providers are one backend behind several front pages —
   * `vidsrcme.ru` and `vidsrcme.su` serve byte-identical documents down to the
   * asset version string. Listing them as separate choices makes the panel look
   * like it offers more than it does, and invites the user to enable all of
   * them, which produces a fallback chain of length one that takes several
   * times as long to fail.
   *
   * So a group shows its first member as the row and hides the rest behind a
   * disclosure. Hidden, not removed: when one domain dies the spare is the
   * whole reason it is in the catalogue.
   */
  type Row =
    | { kind: 'one'; provider: Provider }
    | { kind: 'group'; key: string; lead: Provider; mirrors: Provider[] }

  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = []

    for (const provider of library.orderedProviders) {
      if (!provider.group) {
        out.push({ kind: 'one', provider })
        continue
      }
      // A linear scan rather than an index: a catalogue has tens of entries and
      // one or two groups, so the lookup structure would cost more to read than
      // it saves to run.
      const existing = out.find((r) => r.kind === 'group' && r.key === provider.group)
      if (existing?.kind === 'group') {
        existing.mirrors.push(provider)
        continue
      }
      // The group takes the position of its first member, so the panel's order
      // still matches the user's.
      out.push({ kind: 'group', key: provider.group, lead: provider, mirrors: [] })
    }
    return out
  })

  /**
   * Which mirror groups the user has opened.
   *
   * `SvelteSet`, so mutating it re-renders — a plain Set in `$state` is tracked
   * by reassignment only, and `.add()` on one changes nothing on screen.
   */
  const expanded = new SvelteSet<string>()

  function toggleGroup(key: string): void {
    if (!expanded.delete(key)) expanded.add(key)
  }

  /* ── Reordering ───────────────────────────────────────────────────────── */

  /**
   * Which row the pointer picked up, and which one it is hovering.
   *
   * `armed` is separate from `dragging` because the row is only `draggable`
   * once the grip has been pressed. A permanently draggable row swallows the
   * click that should have hit the checkbox or the star inside it — the browser
   * starts a drag on any mousedown-and-move, and a slightly imprecise click on
   * a small control reads as one.
   */
  let armed = $state<number | null>(null)
  let dragging = $state<number | null>(null)
  let over = $state<number | null>(null)

  /**
   * The providers a row stands for, in the order they must stay in.
   *
   * A mirror group is one row holding several providers, so moving that row
   * moves all of them together. This is the reason the panel rebuilds the whole
   * order rather than sending a move instruction: nothing outside this file
   * knows a row can be more than one provider.
   */
  function idsIn(entry: Row): string[] {
    return entry.kind === 'one'
      ? [entry.provider.id]
      : [entry.lead.id, ...entry.mirrors.map((m) => m.id)]
  }

  function move(from: number, to: number): void {
    const next = [...rows]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    library.setProviderOrder(next.flatMap(idsIn))
  }

  function drop(to: number): void {
    const from = dragging
    dragging = null
    armed = null
    over = null
    if (from !== null && from !== to) move(from, to)
  }

  /**
   * Keyboard reordering, on the same handle.
   *
   * Drag and drop is unusable without a pointer, and this list decides what
   * plays — it is not an ornament that can be keyboard-inaccessible. The `#each`
   * is keyed by provider id, so the row's DOM node moves with it and the handle
   * keeps focus across the reorder, which is what makes repeated presses work.
   */
  function nudge(event: KeyboardEvent, index: number): void {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    event.preventDefault()
    if (index + delta >= 0 && index + delta < rows.length) move(index, index + delta)
  }
</script>

<aside class="panel" in:panelIn out:panelOut>
  <header>
    <h2>Providers</h2>
    <button class="close" onclick={onclose} aria-label="Close providers">✕</button>
  </header>

  <p class="lede">
    <!-- The sentence names whichever control is actually on screen; the two
         differ because drag-and-drop does not work on touch. -->
    Automatic works down this list. {canHover()
      ? 'Drag a row to reorder it.'
      : 'Use the arrows to reorder it.'} Once something has played a title,
    Automatic only tries sources known to work for that title — and starred sources go first.
    WatchThemAll hosts nothing — it only builds the URL.
  </p>

  <!--
    One row, used for a standalone provider and for every member of a mirror
    group, so a mirror is never a second-class control with fewer affordances.
  -->
  {#snippet row(provider: Provider)}
    {@const enabled = active.has(provider.id)}
    <label>
      <input
        type="checkbox"
        checked={enabled}
        onchange={() => library.toggleProvider(provider.id)}
      />
      <span class="name">{provider.name}</span>
    </label>

    <span class="kinds">
      {#if provider.tv}<span class="kind">TV</span>{/if}
      {#if provider.movie}<span class="kind">Film</span>{/if}
    </span>

    <!--
      Always rendered, even for a disabled provider, and disabled rather than
      hidden.

      Two reasons. The row is a grid, so a conditional cell moved every star
      into a different column and the control stopped reading as a column at
      all. And a control that only exists once you have already switched a
      provider on is a control nobody finds — the first version was invisible
      enough to be reported as unimplemented.
    -->
    <button
      class="star"
      class:on={library.isFavourite(provider.id)}
      disabled={!enabled}
      onclick={() => library.toggleFavourite(provider.id)}
      aria-pressed={library.isFavourite(provider.id)}
      aria-label="{library.isFavourite(provider.id) ? 'Unfavourite' : 'Favourite'} {provider.name}"
      title={!enabled
        ? 'Switch this provider on before making it a favourite'
        : library.isFavourite(provider.id)
          ? 'Tried first in Automatic — click to unfavourite'
          : 'Try this first in Automatic'}
    >
      <!-- A stroked SVG rather than a ★ glyph, which renders as a colour
             emoji on some systems and would not match the flat UI. -->
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
      </svg>
    </button>

    {#if library.isCustom(provider.id)}
      <button
        class="drop"
        onclick={() => library.removeCustomProvider(provider.id)}
        aria-label="Delete {provider.name}"
        title="Delete this custom provider">✕</button
      >
    {/if}
  {/snippet}

  <!--
    The handle, and the drag plumbing that goes with it. Rendered ahead of the
    row's own controls so it reads as the row's left edge, which is where a
    grip is looked for.

    On a touch device it is a pair of nudge buttons instead, and that is not a
    nicety: HTML5 drag-and-drop does not respond to touch at all, and the other
    route in — ArrowUp/ArrowDown on the focused grip — needs a keyboard. With
    only those two, **this order could not be changed on a phone**, which is
    the order `automaticOrder` tries providers in and therefore what decides
    what opens when you press Play.
  -->
  {#snippet grip(index: number, name: string)}
    {#if canHover()}
      <button
        class="grip"
        onpointerdown={() => (armed = index)}
        onpointerup={() => (armed = null)}
        onkeydown={(e) => nudge(e, index)}
        aria-label="Reorder {name} — drag, or use the arrow keys"
        title="Drag to reorder. Automatic tries these top to bottom.">⠿</button
      >
    {:else}
      <span class="nudges">
        <button
          class="nudge"
          disabled={index === 0}
          onclick={() => move(index, index - 1)}
          aria-label="Move {name} up"
          title="Automatic tries these top to bottom">▲</button
        >
        <button
          class="nudge"
          disabled={index === rows.length - 1}
          onclick={() => move(index, index + 1)}
          aria-label="Move {name} down"
          title="Automatic tries these top to bottom">▼</button
        >
      </span>
    {/if}
  {/snippet}

  <ul>
    {#each rows as entry, index (entry.kind === 'one' ? entry.provider.id : entry.key)}
      <li
        class:enabled={active.has(entry.kind === 'one' ? entry.provider.id : entry.lead.id)}
        class:dragging={dragging === index}
        class:over={over === index && dragging !== index}
        draggable={armed === index}
        ondragstart={() => (dragging = index)}
        ondragend={() => {
          dragging = null
          armed = null
          over = null
        }}
        ondragover={(e) => {
          // Without this the browser refuses the drop and the row snaps back.
          e.preventDefault()
          over = index
        }}
        ondragleave={() => {
          if (over === index) over = null
        }}
        ondrop={(e) => {
          e.preventDefault()
          drop(index)
        }}
      >
        {@render grip(index, entry.kind === 'one' ? entry.provider.name : entry.lead.name)}
        {#if entry.kind === 'one'}
          {@render row(entry.provider)}
        {:else}
          {@render row(entry.lead)}
          {#if entry.mirrors.length}
            <button
              class="mirrors"
              onclick={() => toggleGroup(entry.key)}
              aria-expanded={expanded.has(entry.key)}
              title="Same stream behind another address"
            >
              {expanded.has(entry.key) ? '▾' : '▸'}
              {entry.mirrors.length} mirror{entry.mirrors.length === 1 ? '' : 's'}
            </button>
          {/if}
        {/if}
      </li>

      <!--
        Mirrors are listed but not draggable: they are the same backend as
        their lead, so a position of their own would be a position that means
        nothing. They follow it wherever it goes.
      -->
      {#if entry.kind === 'group' && expanded.has(entry.key)}
        {#each entry.mirrors as mirror (mirror.id)}
          <li class="mirror" class:enabled={active.has(mirror.id)}>
            {@render row(mirror)}
          </li>
        {/each}
        <p class="mirror-note">
          The same stream behind another address. Enable one as a spare for when the first domain
          goes down — enabling several does not add sources, it only makes a failure take longer to
          discover.
        </p>
      {/if}
    {/each}
  </ul>

  {#if adding}
    <CustomProviderForm oncancel={() => (adding = false)} onsaved={() => (adding = false)} />
  {:else}
    <button class="add" onclick={() => (adding = true)}>+ Add a custom provider</button>
  {/if}

</aside>

<style>
  .panel {
    position: fixed;
    top: var(--nav-height);
    right: 0;
    bottom: 0;
    z-index: 40;
    width: min(380px, 100vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border-left: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-pop);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-4) var(--space-2);
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
  }

  .close {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .lede {
    margin: 0 var(--space-4) var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  ul {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 var(--space-2);
  }

  li {
    display: grid;
    /*
      grip | name | kinds | mirrors | star | delete.

      Every cell below names its column explicitly. Auto-placement plus a
      pinned star put the mirror disclosure onto a second grid row, which
      stretched column one to fit it and left the handle floating in the middle
      of a 70px gap — the row read as centred while every other row was
      flush left.
    */
    grid-template-columns: auto 1fr auto auto auto auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    opacity: 0.55;
  }

  li.enabled {
    opacity: 1;
  }

  li:hover {
    background: var(--bg-elevated);
  }

  /* The row being carried. Dimmed rather than hidden, so the list does not
     reflow underneath the pointer while the drop target is being chosen. */
  li.dragging {
    opacity: 0.35;
  }

  /* Where it would land. A line rather than a filled row: the row is still
     showing its own contents, and shading it reads as a selection. */
  li.over {
    box-shadow: inset 0 2px 0 var(--accent);
  }

  .grip {
    grid-column: 1;
    padding: 0 2px;
    font-size: var(--text-sm);
    line-height: 1;
    color: var(--text-tertiary);
    cursor: grab;
    background: none;
    border: none;
  }

  .grip:hover,
  .grip:focus-visible {
    color: var(--text-secondary);
  }

  /*
    The touch replacement for the grip, in the same grid column so the rows
    line up whichever one is rendered. Stacked rather than side by side: the
    row is already three columns wide at 412px and a second horizontal control
    would take the width from the provider's name.
  */
  .nudges {
    grid-column: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nudge {
    padding: 4px 6px;
    font-size: 10px;
    line-height: 1;
    color: var(--text-tertiary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }

  .nudge:disabled {
    opacity: 0.35;
  }

  li.dragging .grip {
    cursor: grabbing;
  }

  label {
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    min-width: 0;
  }

  .name {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Indented under their lead, so the hierarchy is visible without a border. */
  /* No handle: a mirror cannot be positioned independently of its group, so it
     would be a control that does nothing. Column one is simply empty, and the
     indent is what marks the row as subordinate. */
  li.mirror {
    padding-left: var(--space-6);
    opacity: 0.9;
  }

  .mirrors {
    grid-column: 4;
    grid-row: 1;
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .mirrors:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .mirror-note {
    margin: 0 0 var(--space-3);
    padding: 0 var(--space-2) 0 var(--space-6);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .kinds {
    grid-column: 3;
    display: flex;
    gap: 3px;
  }

  .kind {
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
  }

  /*
    Pinned to the row's last grid track, so every star lines up in a column
    whatever else the row carries — a mirrors disclosure, a delete button, or
    nothing. `order` alone was not enough: it puts the star last among the
    items, but rows hold different numbers of them, so it still landed in a
    different column and the stars sat 8px apart.
  */
  .star {
    grid-column: 5;
    grid-row: 1;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    /* Secondary, not tertiary. At tertiary on this background the outline was
       faint enough that the control read as absent. */
    color: var(--text-secondary);
    line-height: 0;
  }

  .star svg {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
  }

  .star:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .star:disabled {
    opacity: 0.25;
    cursor: default;
  }

  /* Filled as well as coloured: on a small glyph the fill is what reads at a
     glance, and colour alone would not survive a colour-blind reader. */
  .star.on {
    color: var(--accent);
  }

  .star.on svg {
    fill: currentColor;
  }

  .add {
    margin: 0 var(--space-4) var(--space-3);
    padding: var(--space-2);
    border-radius: var(--radius-md);
    border: 1px dashed var(--border-strong);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .drop {
    grid-column: 6;
    grid-row: 1;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: 9px;
  }
  .drop:hover {
    background: var(--bg-hover);
    color: var(--danger);
  }

</style>
