/**
 * The Cast protocol's envelope, encoded by hand.
 *
 * ## Why by hand
 *
 * Talking to a Chromecast means a TLS socket on port 8009 carrying framed
 * `CastMessage` protobufs, each of which holds a JSON string. The obvious move
 * is `castv2-client`, and it is the wrong one here: it was last published in
 * 2019, it pulls `protobufjs@6` and `debug@2` behind it, and this project has
 * **no runtime dependencies at all** — that property is worth more than the
 * three hundred lines it would save.
 *
 * The deciding argument is not purity though. Neither a library nor this can be
 * tested against a real Chromecast from the build machine, so the risk of "does
 * not work on the device" is the same either way. What differs is what happens
 * next: this is debuggable and fixable, and the wire format below is covered by
 * tests that run in the ordinary suite.
 *
 * ## What the envelope actually is
 *
 * `CastMessage` is a seven-field protobuf message and every field is either a
 * varint or a length-delimited string. There is no nesting, no repetition, no
 * map, and no floating point — which is why encoding it by hand is a page of
 * code rather than a project.
 *
 *     1 protocol_version  varint   (0 = CASTV2_1_0, the only value in use)
 *     2 source_id         string
 *     3 destination_id    string
 *     4 namespace         string
 *     5 payload_type      varint   (0 = STRING, 1 = BINARY)
 *     6 payload_utf8      string
 *     7 payload_binary    bytes
 *
 * Everything interesting — LAUNCH, LOAD, PAUSE, the media status — travels as
 * JSON inside `payload_utf8`. This file never looks at it.
 *
 * The schema has not changed since 2012 and cannot without breaking every
 * Chromecast in existence, so hand-encoding it is not the hostage to fortune it
 * would be for a protocol under development.
 */

/** Wire types used by this message. No others can occur in it. */
const WIRE_VARINT = 0
const WIRE_LENGTH_DELIMITED = 2

export interface CastMessage {
  /** Who is speaking. `sender-0`, or a per-connection id. */
  sourceId: string
  /** `receiver-0` for the device itself, or an application's transport id. */
  destinationId: string
  /** e.g. `urn:x-cast:com.google.cast.media` */
  namespace: string
  /** The JSON the other side actually acts on. */
  payload: string
}

/* ── Varints ────────────────────────────────────────────────────────────── */

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function decodeVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let index = offset
  for (;;) {
    if (index >= buffer.length) throw new Error('varint runs past the end of the buffer')
    // `readUInt8` rather than an index: this project compiles with
    // `noUncheckedIndexedAccess`, so `buffer[i]` is `number | undefined` and
    // every read would need a redundant guard after the one above.
    const byte = buffer.readUInt8(index)
    index += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: index }
    shift += 7
    // A CastMessage carries only small enums and lengths; anything needing more
    // than five bytes is a corrupt stream rather than a large number.
    if (shift > 35) throw new Error('varint is too long to be part of a CastMessage')
  }
}

function tag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType)
}

function lengthDelimited(field: number, value: Buffer): Buffer {
  return Buffer.concat([tag(field, WIRE_LENGTH_DELIMITED), encodeVarint(value.length), value])
}

/* ── The message ────────────────────────────────────────────────────────── */

/**
 * Serialise a message, without its length prefix. See `frame`.
 *
 * Fields are emitted in ascending number order. Protobuf does not require it
 * and every decoder tolerates any order, but a deterministic encoding is what
 * lets a test assert on bytes instead of on a re-decode.
 */
export function encodeCastMessage(message: CastMessage): Buffer {
  const payload = Buffer.from(message.payload, 'utf8')
  return Buffer.concat([
    tag(1, WIRE_VARINT),
    encodeVarint(0), // protocol_version: CASTV2_1_0
    lengthDelimited(2, Buffer.from(message.sourceId, 'utf8')),
    lengthDelimited(3, Buffer.from(message.destinationId, 'utf8')),
    lengthDelimited(4, Buffer.from(message.namespace, 'utf8')),
    tag(5, WIRE_VARINT),
    encodeVarint(0), // payload_type: STRING
    lengthDelimited(6, payload),
  ])
}

/**
 * Parse a message body.
 *
 * Unknown fields are skipped rather than rejected — that is what protobuf's
 * forward compatibility is for, and a receiver firmware that starts sending a
 * field this file has never heard of must not break the connection.
 */
export function decodeCastMessage(buffer: Buffer): CastMessage {
  const message: CastMessage = { sourceId: '', destinationId: '', namespace: '', payload: '' }
  let offset = 0

  while (offset < buffer.length) {
    const header = decodeVarint(buffer, offset)
    offset = header.next
    const field = header.value >>> 3
    const wireType = header.value & 0x07

    if (wireType === WIRE_VARINT) {
      offset = decodeVarint(buffer, offset).next
      continue
    }
    if (wireType !== WIRE_LENGTH_DELIMITED) {
      throw new Error(`unexpected wire type ${wireType} in a CastMessage`)
    }

    const size = decodeVarint(buffer, offset)
    offset = size.next
    const end = offset + size.value
    if (end > buffer.length) throw new Error('a field runs past the end of the message')
    const value = buffer.subarray(offset, end)
    offset = end

    switch (field) {
      case 2:
        message.sourceId = value.toString('utf8')
        break
      case 3:
        message.destinationId = value.toString('utf8')
        break
      case 4:
        message.namespace = value.toString('utf8')
        break
      case 6:
        message.payload = value.toString('utf8')
        break
      default:
        // Including payload_binary (7), which nothing here sends or reads.
        break
    }
  }

  return message
}

/* ── Framing ────────────────────────────────────────────────────────────── */

/** Prefix a serialised message with its big-endian 32-bit length. */
export function frame(body: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Pull whole messages out of a stream buffer.
 *
 * TLS gives no message boundaries, so a read can deliver half a message, three
 * messages, or two and a half. Returns what is complete and what is left over;
 * the caller keeps the remainder and prepends it to the next read. Getting this
 * wrong is the classic way a protocol client works on a fast local network and
 * falls apart on a slow one.
 */
export function unframe(buffer: Buffer): { messages: Buffer[]; rest: Buffer } {
  const messages: Buffer[] = []
  let offset = 0

  while (buffer.length - offset >= 4) {
    const size = buffer.readUInt32BE(offset)
    if (buffer.length - offset - 4 < size) break
    messages.push(buffer.subarray(offset + 4, offset + 4 + size))
    offset += 4 + size
  }

  return { messages, rest: buffer.subarray(offset) }
}

/* ── Namespaces ─────────────────────────────────────────────────────────── */

export const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
export const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat'
export const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver'
export const NS_MEDIA = 'urn:x-cast:com.google.cast.media'

/**
 * Google's Default Media Receiver.
 *
 * The same choice the Android app makes, for the same reason: the usual point
 * of a custom receiver is attaching headers to the media request, and the proxy
 * has already done that a layer lower. See `castproxy.ts`.
 */
export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'
