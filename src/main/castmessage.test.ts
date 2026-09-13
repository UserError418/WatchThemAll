import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { decodeCastMessage, encodeCastMessage, frame, unframe, type CastMessage } from './castmessage'

const CONNECT: CastMessage = {
  sourceId: 'sender-0',
  destinationId: 'receiver-0',
  namespace: 'urn:x-cast:com.google.cast.tp.connection',
  payload: '{"type":"CONNECT"}',
}

describe('encodeCastMessage', () => {
  /**
   * The bytes, asserted literally.
   *
   * This is the one place where a re-decode would prove nothing: an encoder and
   * decoder that are wrong in the same way agree perfectly. A Chromecast does
   * not, so the field numbers and wire types are pinned here against the
   * published CastMessage schema rather than against this file's own opinion.
   */
  it('emits exactly the bytes the CastMessage schema specifies', () => {
    // Single-character fields so every byte is unambiguous. Scanning for a tag
    // byte does not work on a realistic message: the namespace
    // "urn:x-cast:com.google.cast.tp.connection" is 40 characters, so its own
    // length prefix is 0x28 — the same byte as the payload_type tag.
    const tiny: CastMessage = { sourceId: 'a', destinationId: 'b', namespace: 'c', payload: 'd' }

    expect([...encodeCastMessage(tiny)]).toEqual([
      0x08, 0x00,             // 1 protocol_version = CASTV2_1_0
      0x12, 0x01, 0x61,       // 2 source_id      = "a"
      0x1a, 0x01, 0x62,       // 3 destination_id = "b"
      0x22, 0x01, 0x63,       // 4 namespace      = "c"
      0x28, 0x00,             // 5 payload_type   = STRING
      0x32, 0x01, 0x64,       // 6 payload_utf8   = "d"
    ])
  })

  it('encodes deterministically', () => {
    expect(encodeCastMessage(CONNECT)).toEqual(encodeCastMessage(CONNECT))
  })
})

describe('round trip', () => {
  it('survives the four fields that carry meaning', () => {
    expect(decodeCastMessage(encodeCastMessage(CONNECT))).toEqual(CONNECT)
  })

  /**
   * Media payloads are large and full of the characters that break naive
   * length handling — a proxy URL with a query string, a title with an accent,
   * a manifest id. A varint length is byte-based and a JS string length is not,
   * which is precisely the bug this catches.
   */
  it('survives arbitrary payloads, including multi-byte characters', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (a, b, c, payload) => {
        const message: CastMessage = { sourceId: a, destinationId: b, namespace: c, payload }
        expect(decodeCastMessage(encodeCastMessage(message))).toEqual(message)
      }),
      { numRuns: 200 },
    )
  })

  it('handles a payload long enough to need a multi-byte length', () => {
    const message: CastMessage = { ...CONNECT, payload: JSON.stringify({ blob: 'x'.repeat(5000) }) }
    expect(decodeCastMessage(encodeCastMessage(message)).payload).toBe(message.payload)
  })
})

describe('decodeCastMessage', () => {
  /**
   * Forward compatibility is not decoration here. A firmware that starts
   * sending a field this file has never heard of must not take the connection
   * down mid-film.
   */
  it('skips fields it does not know', () => {
    const known = encodeCastMessage(CONNECT)
    // field 9, varint, value 42 -> tag (9<<3)|0 = 0x48
    const withExtra = Buffer.concat([known, Buffer.from([0x48, 42])])
    expect(decodeCastMessage(withExtra)).toEqual(CONNECT)
  })

  it('skips an unknown length-delimited field', () => {
    const known = encodeCastMessage(CONNECT)
    // field 7 (payload_binary), length 3 -> tag (7<<3)|2 = 0x3a
    const withBinary = Buffer.concat([known, Buffer.from([0x3a, 3, 1, 2, 3])])
    expect(decodeCastMessage(withBinary)).toEqual(CONNECT)
  })

  it('refuses a field that claims to run past the end', () => {
    // field 2, length 200, but only two bytes follow.
    expect(() => decodeCastMessage(Buffer.from([0x12, 200, 1, 2]))).toThrow(/past the end/)
  })

  it('refuses a truncated varint rather than inventing a value', () => {
    expect(() => decodeCastMessage(Buffer.from([0x80]))).toThrow()
  })
})

describe('framing', () => {
  it('prefixes the length big-endian', () => {
    const framed = frame(Buffer.from([1, 2, 3]))
    expect(framed.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 3]))
    expect(framed.subarray(4)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('reads several messages out of one buffer', () => {
    const stream = Buffer.concat([frame(Buffer.from('aa')), frame(Buffer.from('bbb'))])
    const { messages, rest } = unframe(stream)

    expect(messages.map((m) => m.toString())).toEqual(['aa', 'bbb'])
    expect(rest).toHaveLength(0)
  })

  /**
   * The failure this exists to prevent: TLS delivers no message boundaries, so
   * a read can end halfway through one. A client that assumes otherwise works
   * on a fast local network and falls apart on a slow one — the worst shape a
   * protocol bug can take, because it passes every test written on a desk.
   */
  it('holds a partial message back instead of misreading it', () => {
    const whole = frame(Buffer.from('hello'))

    for (let cut = 1; cut < whole.length; cut += 1) {
      const first = unframe(whole.subarray(0, cut))
      expect(first.messages).toHaveLength(0)

      const second = unframe(Buffer.concat([first.rest, whole.subarray(cut)]))
      expect(second.messages.map((m) => m.toString())).toEqual(['hello'])
      expect(second.rest).toHaveLength(0)
    }
  })

  it('never loses or duplicates a message however the stream is chopped', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 7 }),
        (payloads, chunkSize) => {
          const stream = Buffer.concat(payloads.map((p) => frame(Buffer.from(p, 'utf8'))))

          const seen: string[] = []
          let pending: Buffer = Buffer.alloc(0)
          for (let at = 0; at < stream.length; at += chunkSize) {
            pending = Buffer.concat([pending, stream.subarray(at, at + chunkSize)])
            const { messages, rest } = unframe(pending)
            for (const message of messages) seen.push(message.toString('utf8'))
            pending = rest
          }

          expect(seen).toEqual(payloads)
          expect(pending).toHaveLength(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
