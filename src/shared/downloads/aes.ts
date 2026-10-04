/**
 * AES-128 segments (`#EXT-X-KEY:METHOD=AES-128`), decrypted as they are
 * saved so the local playlist needs no key and playback needs no network.
 *
 * WebCrypto, which both platforms have (Node's `globalThis.crypto`, the
 * phone's WebView in its secure `https://localhost` context): AES-CBC with
 * PKCS#7 padding, which is exactly HLS's AES-128, and which WebCrypto strips
 * by itself.
 */

/**
 * The IV of a segment: the key line's own when it names one, else the
 * segment's media sequence number as a 16-byte big-endian integer (RFC 8216,
 * 5.2). Renumbering segments would therefore decrypt every one wrongly,
 * which is why a plan keeps each segment's own sequence.
 */
export function ivFor(segment: { iv: string | null; sequence: number }): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16)
  if (segment.iv !== null) {
    const hex = segment.iv.replace(/^0[xX]/, '').padStart(32, '0').slice(-32)
    for (let i = 0; i < 16; i++) iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return iv
  }
  // Sequence numbers fit well inside 2^53; written into the low 8 bytes.
  let n = segment.sequence
  for (let i = 15; i >= 8 && n > 0; i--) {
    iv[i] = n % 256
    n = Math.floor(n / 256)
  }
  return iv
}

/** A key's bytes, ready to decrypt with. Null when they are not a 16-byte key (a source answering with a page). */
export async function importAesKey(bytes: Uint8Array): Promise<CryptoKey | null> {
  if (bytes.length !== 16) return null
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-CBC' }, false, ['decrypt'])
}

/** One segment in the clear; null when it does not decrypt (wrong key, or not the encrypted segment). */
export async function decryptSegment(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, key, data as BufferSource))
  } catch {
    return null
  }
}
