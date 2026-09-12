/**
 * Is this URL the provider's, or does it merely start like it?
 *
 * `url.startsWith(origin)` looks like an origin check and is not one. An origin
 * has no trailing delimiter, so `https://player.videasy.to` is a prefix of
 * `https://player.videasy.to.evil.example/collect` — a hostname anybody can
 * register. Three places in this codebase made that comparison, and one of them
 * mattered:
 *
 * - `identity.ts` attaches the provider's `Referer` to requests it believes are
 *   the provider's own. Under a prefix match, a lookalike host would be handed
 *   the referrer — which is precisely the leak the code was written to prevent.
 * - `switchoffer.ts` would blame the provider for a stranger's failed request
 *   and offer to change source over it.
 * - `streamprobe.ts` would record the same as an API error against the
 *   provider's catalogue entry.
 *
 * Comparing parsed origins is the fix, and it is cheap: `URL` normalises the
 * scheme, the host and the default port, so there is nothing left to get wrong
 * with delimiters.
 */

/** True when `url` is on exactly `origin`. Malformed input is never a match. */
export function isSameOrigin(url: string, origin: string | null): boolean {
  if (origin === null) return false
  try {
    return new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}
