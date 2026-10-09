/** The types of `phonereach.js`, for the test that imports it. See there. */

export interface PhoneReach {
  /** Every `.ts` and `.svelte` file the bundle reaches, relative to the root, `/`-separated, sorted. */
  files: string[]
  /** Every package a reached file imports at run time, with the files that import it. */
  packages: Map<string, string[]>
}

export const PHONE_ENTRY: string

export function phoneReach(root: string, entries?: string[]): PhoneReach
