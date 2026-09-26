/**
 * Which artwork the browse cards draw: the wide backdrop, or the poster.
 *
 * The desktop's rows are landscape because a desktop card grows into a
 * trailer, and a trailer is 16:9. The phone's rows are posters, three and a
 * bit across, the way Netflix's phone shelves are — there is no hover to grow
 * into, and a narrow screen shows three times as many titles that way.
 *
 * The shape is a stylesheet decision, like every other phone dimension:
 * `--card-ratio` and `--card-width`, retuned in `mobile.css`. The artwork has
 * to follow the shape — a backdrop cropped to a portrait frame keeps a thin
 * slice from the middle of a wide image — so the sheet also says which art its
 * shape wants, in `--card-art`, and this reads it. That keeps the renderer free
 * of a platform branch (see `pointer.ts` for why there is none): the phone
 * build differs only in what its stylesheet sets.
 *
 * Read on first use rather than at import. The mobile entry imports the app
 * before its stylesheet, so at import time the token is not there yet; by the
 * time a card exists, it is. Cached after that, because a stylesheet does not
 * change under a running app.
 */

export type CardArt = 'backdrop' | 'poster'

let chosen: CardArt | null = null

export function cardArt(): CardArt {
  chosen ??=
    getComputedStyle(document.documentElement).getPropertyValue('--card-art').trim() === 'poster'
      ? 'poster'
      : 'backdrop'
  return chosen
}
