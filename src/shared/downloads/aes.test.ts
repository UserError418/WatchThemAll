import { describe, expect, it } from 'vitest'
import { decryptSegment, importAesKey, ivFor } from './aes'

describe('ivFor', () => {
  it('is the media sequence number, big-endian, when the key line names no IV', () => {
    const iv = ivFor({ iv: null, sequence: 0x0102 })
    expect([...iv.slice(0, 14)].every((b) => b === 0)).toBe(true)
    expect([iv[14], iv[15]]).toEqual([0x01, 0x02])
  })

  it('is the key line\'s own IV when it names one', () => {
    const iv = ivFor({ iv: '0x000102030405060708090A0B0C0D0E0F', sequence: 99 })
    expect([...iv]).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(ivFor({ iv: '0x1', sequence: 5 })[15]).toBe(1)
  })
})

describe('decryptSegment', () => {
  it('undoes HLS AES-128 (CBC, PKCS#7)', async () => {
    const raw = new Uint8Array(16).map((_, i) => i * 7)
    const iv = ivFor({ iv: null, sequence: 42 })
    const plain = new TextEncoder().encode('a transport stream, more or less')
    const encryptKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt'])
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encryptKey, plain))
    const key = (await importAesKey(raw))!
    expect(await decryptSegment(cipher, key, iv)).toEqual(plain)
  })

  it('refuses a key that is not 16 bytes, and a segment that does not decrypt', async () => {
    expect(await importAesKey(new Uint8Array(20))).toBeNull()
    const key = (await importAesKey(new Uint8Array(16)))!
    expect(await decryptSegment(new Uint8Array(15), key, new Uint8Array(16))).toBeNull()
  })
})
