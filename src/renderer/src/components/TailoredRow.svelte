<script lang="ts">
  /**
   * The one row on Browse that is about this user specifically.
   *
   * Everything else on the page is either a TMDB chart or a genre shelf. This
   * asks the main process what to recommend and renders the answer, including
   * the *reason* — the genres it was built from, named in the heading.
   *
   * Naming the reason is not decoration. A "for you" row with no stated basis
   * is unfalsifiable: the user cannot tell a real recommendation from popular
   * titles in a different order, so they stop reading it. "Because you liked
   * Drama and Sci-Fi" is a claim they can check against their own library, and
   * a claim that can be wrong is one worth trusting when it is right.
   *
   * It renders nothing at all below a threshold of saved and rated titles. A
   * recommendation derived from two watchlist entries is a guess in the costume
   * of a recommendation, and an empty space is more honest than that.
   */
  import type { MediaSummary } from '@shared/types'
  import RowShell from './RowShell.svelte'
  import TitleCard from './TitleCard.svelte'
  import { shown } from '../lib/shown.svelte'
  import { library } from '../lib/library.svelte'

  interface Props {
    genreNames: Map<number, string>
    onselect: (media: MediaSummary) => void
  }

  const { genreNames, onselect }: Props = $props()

  let items = $state<MediaSummary[]>([])
  let genreIds = $state<number[]>([])
  let ready = $state(false)
  let loading = $state(true)

  /**
   * Refetch when the library changes.
   *
   * Reading the three lists' lengths is what subscribes this effect to them, so
   * rating something or marking it watched updates the row without a reload.
   * Lengths rather than contents: a rating flipping like→dislike is worth a
   * refetch, and its length change covers add and remove, which are the cases
   * that actually move the genre weights.
   */
  $effect(() => {
    void library.ratings.length
    void library.watched.length
    void library.watchlist.length
    void load()
  })

  async function load(): Promise<void> {
    loading = true
    try {
      const result = await window.wta.tmdb.tailored({ tailored: true, page: 1 })
      ready = result.ready
      genreIds = result.genreIds
      // Claim through the same registry the other rows use, so a title here
      // does not also appear three shelves down.
      items = shown.claim('tailored', result.items).slice(0, 20)
    } catch (err) {
      // A failed recommendation is not worth a message; the page has plenty
      // else on it and the row simply does not appear.
      console.error('[browse] tailored row failed:', err)
      ready = false
    } finally {
      loading = false
    }
  }

  /**
   * "Because you liked Drama and Sci-Fi".
   *
   * Two genres named at most: three reads as a list rather than a reason, and
   * the third weight is usually a long tail that had little to do with it.
   */
  const heading = $derived.by(() => {
    const named = genreIds.map((id) => genreNames.get(id)).filter((n) => n !== undefined)
    if (named.length === 0) return 'Picked for you'
    if (named.length === 1) return `Because you like ${named[0]}`
    return `Because you like ${named[0]} and ${named[1]}`
  })
</script>

{#if ready && !loading && items.length > 0}
  <RowShell title={heading} loaded eager>
    {#each items as media, index (`${media.type}-${media.tmdbId}`)}
      <TitleCard
        {media}
        {onselect}
        anchor={index === 0 ? 'start' : index === items.length - 1 ? 'end' : 'center'}
      />
    {/each}
  </RowShell>
{/if}
