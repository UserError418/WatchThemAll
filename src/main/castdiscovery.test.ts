import { describe, it, expect } from 'vitest'
import { buildQuery, devicesFrom, parseResponse, type Record } from './castdiscovery'

/* ── Building synthetic packets ─────────────────────────────────────────── */

function name(value: string): Buffer {
  const labels = value.split('.').filter(Boolean)
  return Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'utf8')])),
    Buffer.from([0]),
  ])
}

/** A record whose own name is a compression pointer to `pointsTo`. */
function record(nameBytes: Buffer, type: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2) // class IN
  head.writeUInt32BE(120, 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([nameBytes, head, rdata])
}

function response(records: Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0x8400, 2) // response, authoritative
  header.writeUInt16BE(0, 4) // no questions
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

function txtRdata(pairs: string[]): Buffer {
  return Buffer.concat(
    pairs.map((pair) => Buffer.concat([Buffer.from([Buffer.byteLength(pair)]), Buffer.from(pair, 'utf8')])),
  )
}

function srvRdata(port: number, target: string): Buffer {
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0) // priority
  head.writeUInt16BE(0, 2) // weight
  head.writeUInt16BE(port, 4)
  return Buffer.concat([head, name(target)])
}

const INSTANCE = 'Chromecast-abc123._googlecast._tcp.local'
const HOST = 'abc123.local'

describe('buildQuery', () => {
  it('asks for the Chromecast service by PTR', () => {
    const query = buildQuery()

    expect(query.readUInt16BE(4)).toBe(1) // one question
    expect(query.readUInt16BE(query.length - 4)).toBe(12) // PTR
    expect(query.readUInt16BE(query.length - 2)).toBe(1) // class IN
    expect(query.toString('utf8')).toContain('_googlecast')
  })

  /**
   * Transaction id 0 is deliberate: mDNS matches responses by question rather
   * than by id, and a non-zero id makes some responders answer unicast when the
   * reply is wanted on the group.
   */
  it('uses transaction id zero', () => {
    expect(buildQuery().readUInt16BE(0)).toBe(0)
  })
})

describe('parseResponse', () => {
  it('reads A, SRV and TXT out of one reply', () => {
    const packet = response([
      record(name(INSTANCE), 33, srvRdata(8009, HOST)),
      record(name(INSTANCE), 16, txtRdata(['id=abc123', 'fn=Wohnzimmer'])),
      record(name(HOST), 1, Buffer.from([192, 168, 1, 42])),
    ])

    const records = parseResponse(packet)
    const srv = records.find((r) => r.type === 33)
    const txt = records.find((r) => r.type === 16)
    const a = records.find((r) => r.type === 1)

    expect(srv?.port).toBe(8009)
    expect(srv?.data).toBe(HOST)
    expect(txt?.txt?.get('fn')).toBe('Wohnzimmer')
    expect(a?.data).toBe('192.168.1.42')
  })

  /**
   * The failure this file exists to avoid. A real responder points back into
   * earlier bytes instead of repeating a name, so a parser that ignores
   * pointers reads rubbish for nearly every record — while passing happily
   * against hand-written uncompressed packets like the one above.
   */
  it('follows a compression pointer rather than reading the pointer bytes', () => {
    const first = record(name(INSTANCE), 16, txtRdata(['fn=Küche']))
    // The instance name starts at byte 12, immediately after the header.
    const pointer = Buffer.from([0xc0, 12])
    const second = record(pointer, 33, srvRdata(8009, HOST))
    const third = record(name(HOST), 1, Buffer.from([10, 0, 0, 7]))

    const records = parseResponse(response([first, second, third]))
    const srv = records.find((r) => r.type === 33)

    expect(srv?.name).toBe(INSTANCE)
    expect(srv?.port).toBe(8009)
    expect(devicesFrom(records)).toEqual([
      { id: 'Chromecast-abc123', name: 'Küche', address: '10.0.0.7', port: 8009 },
    ])
  })

  it('follows a pointer inside SRV rdata, where the target usually is', () => {
    const hostRecord = record(name(HOST), 1, Buffer.from([10, 0, 0, 8]))
    // The host name sits at byte 12 of this packet.
    const srv = record(name(INSTANCE), 33, Buffer.concat([Buffer.alloc(6), Buffer.from([0xc0, 12])]))
    const records = parseResponse(response([hostRecord, srv]))

    expect(records.find((r) => r.type === 33)?.data).toBe(HOST)
  })

  it('skips the question section before reading answers', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x8400, 2)
    header.writeUInt16BE(1, 4) // one question
    header.writeUInt16BE(1, 6) // one answer
    const question = Buffer.concat([name('_googlecast._tcp.local'), Buffer.from([0, 12, 0, 1])])
    const answer = record(name(HOST), 1, Buffer.from([172, 16, 0, 3]))

    expect(parseResponse(Buffer.concat([header, question, answer]))[0]?.data).toBe('172.16.0.3')
  })

  it('returns nothing for a runt packet instead of throwing', () => {
    expect(parseResponse(Buffer.from([1, 2, 3]))).toEqual([])
  })

  it('stops cleanly when a record claims more data than the packet holds', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 6)
    const head = Buffer.alloc(10)
    head.writeUInt16BE(1, 0)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(9000, 8) // rdlength far past the end
    expect(() => parseResponse(Buffer.concat([header, name(HOST), head]))).not.toThrow()
  })
})

describe('devicesFrom', () => {
  const base: Record[] = [
    { name: INSTANCE, type: 33, data: HOST, port: 8009 },
    { name: INSTANCE, type: 16, data: '', txt: new Map([['id', 'uuid-1'], ['fn', 'Wohnzimmer']]) },
    { name: HOST, type: 1, data: '192.168.1.42' },
  ]

  it('joins SRV, TXT and A into one device', () => {
    expect(devicesFrom(base)).toEqual([
      { id: 'uuid-1', name: 'Wohnzimmer', address: '192.168.1.42', port: 8009 },
    ])
  })

  /**
   * A device that cannot be connected to is worse than a shorter list: the user
   * taps it, nothing happens, and nothing explains why.
   */
  it('drops a device whose address never arrived', () => {
    expect(devicesFrom(base.filter((r) => r.type !== 1))).toEqual([])
  })

  it('falls back to the instance name when TXT carries no friendly name', () => {
    const devices = devicesFrom(base.filter((r) => r.type !== 16))
    expect(devices[0]?.name).toBe('Chromecast-abc123')
    expect(devices[0]?.id).toBe('Chromecast-abc123')
  })

  /** mDNS repeats itself; three replies about one TV are one entry in the list. */
  it('does not list the same device twice', () => {
    expect(devicesFrom([...base, ...base, ...base])).toHaveLength(1)
  })

  it('sorts by name so the list does not reshuffle between refreshes', () => {
    const second: Record[] = [
      { name: 'x._googlecast._tcp.local', type: 33, data: 'x.local', port: 8009 },
      { name: 'x._googlecast._tcp.local', type: 16, data: '', txt: new Map([['id', 'uuid-2'], ['fn', 'Atelier']]) },
      { name: 'x.local', type: 1, data: '192.168.1.9' },
    ]
    expect(devicesFrom([...base, ...second]).map((d) => d.name)).toEqual(['Atelier', 'Wohnzimmer'])
  })
})
