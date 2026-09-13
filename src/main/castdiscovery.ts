/**
 * Finding Chromecasts on the network, without a dependency.
 *
 * A Chromecast announces itself over multicast DNS as `_googlecast._tcp.local`.
 * Asking for it means one UDP packet to 224.0.0.251:5353 and reading the
 * replies, which carry four record types between them:
 *
 *   PTR  the service name          -> an instance name
 *   SRV  the instance              -> a port and a host
 *   TXT  key=value pairs, of which `fn` is the name the user gave the device
 *   A    the host                  -> an IPv4 address
 *
 * The alternative was `multicast-dns`, and the reasoning is the same as in
 * `castmessage.ts`: this project has no runtime dependencies, neither option
 * could be tested against real hardware from the build machine, and the parsing
 * below is covered by tests that run in the ordinary suite. A library would
 * have bought an untestable black box instead of an untestable page of code.
 *
 * **Name compression is the part that must be right.** mDNS responses point
 * back into earlier bytes of the same packet rather than repeating a name, so a
 * parser that does not follow those pointers reads garbage for almost every
 * record in a real reply — and reads perfectly in any test built from
 * hand-written, uncompressed packets. There is a test for it below built from a
 * compressed one.
 */

import { createSocket } from 'node:dgram'

export const CAST_SERVICE = '_googlecast._tcp.local'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353

const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_SRV = 33
const CLASS_IN = 1

/**
 * "Answer me directly, not the whole group."
 *
 * The top bit of a question's class. Set on the query sent from an ephemeral
 * port, because a socket on port 34567 will never receive a multicast reply
 * addressed to port 5353 — multicast is delivered by destination port, so
 * joining the group does not help.
 */
const QU_BIT = 0x8000

/** One record, reduced to what discovery actually uses. */
export interface Record {
  name: string
  type: number
  /** A: the address. PTR/SRV: the target name. TXT: the joined strings. */
  data: string
  /** SRV only. */
  port?: number
  /** TXT only, already split on `=`. */
  txt?: Map<string, string>
}

/** A television, as far as one mDNS exchange can tell. */
export interface DiscoveredDevice {
  /** The device's own id — stable, and what `connect` is given. */
  id: string
  /** What the user called it. Falls back to the instance name. */
  name: string
  address: string
  port: number
}

/* ── Names ──────────────────────────────────────────────────────────────── */

/**
 * Read a DNS name, following compression pointers.
 *
 * Returns the name and the offset *after* the name as it appeared here, which
 * is not the same as where reading finished: a pointer is two bytes in the
 * record regardless of how far away the name it names lives.
 */
function readName(buffer: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = []
  let offset = start
  let next = -1
  // A malformed packet can point in a loop; every jump must move the reader
  // backwards, and this bounds it regardless.
  let jumps = 0

  for (;;) {
    if (offset >= buffer.length) break
    const length = buffer.readUInt8(offset)

    if (length === 0) {
      if (next < 0) next = offset + 1
      break
    }

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) break
      const pointer = ((length & 0x3f) << 8) | buffer.readUInt8(offset + 1)
      if (next < 0) next = offset + 2
      offset = pointer
      jumps += 1
      if (jumps > 64) break
      continue
    }

    const from = offset + 1
    labels.push(buffer.subarray(from, from + length).toString('utf8'))
    offset = from + length
  }

  return { name: labels.join('.'), next: next < 0 ? offset : next }
}

function writeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean)
  const chunks = parts.map((label) => {
    const bytes = Buffer.from(label, 'utf8')
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return Buffer.concat([...chunks, Buffer.from([0])])
}

/* ── Packets ────────────────────────────────────────────────────────────── */

/**
 * One PTR question for `service`.
 *
 * `unicastResponse` sets the QU bit — the top bit of the question's class —
 * which asks responders to answer this socket directly instead of shouting the
 * reply at the whole group. That is what lets discovery work from an ephemeral
 * port, and see `discover` for why it has to.
 */
export function buildQuery(service: string = CAST_SERVICE, unicastResponse = false): Buffer {
  const header = Buffer.alloc(12)
  // Transaction id 0: mDNS matches responses by question, not by id.
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0, 2) // standard query, no flags
  header.writeUInt16BE(1, 4) // one question
  const question = Buffer.concat([writeName(service), Buffer.alloc(4)])
  question.writeUInt16BE(TYPE_PTR, question.length - 4)
  question.writeUInt16BE(unicastResponse ? CLASS_IN | QU_BIT : CLASS_IN, question.length - 2)
  return Buffer.concat([header, question])
}

/**
 * Pull every answer record out of a response.
 *
 * Questions are skipped and the three answer sections are read as one: a
 * responder is free to put the SRV in "additional" rather than "answer", and
 * several do, so honouring the distinction would drop half the useful records.
 */
export function parseResponse(buffer: Buffer): Record[] {
  if (buffer.length < 12) return []

  const questions = buffer.readUInt16BE(4)
  const total = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10)

  let offset = 12
  for (let index = 0; index < questions; index += 1) {
    const { next } = readName(buffer, offset)
    offset = next + 4
  }

  const records: Record[] = []
  for (let index = 0; index < total; index += 1) {
    if (offset + 10 > buffer.length) break
    const { name, next } = readName(buffer, offset)
    offset = next

    const type = buffer.readUInt16BE(offset)
    const rdLength = buffer.readUInt16BE(offset + 8)
    offset += 10
    const rdStart = offset
    if (rdStart + rdLength > buffer.length) break
    offset += rdLength

    switch (type) {
      case TYPE_A:
        if (rdLength === 4) {
          records.push({
            name,
            type,
            data: [0, 1, 2, 3].map((byte) => buffer.readUInt8(rdStart + byte)).join('.'),
          })
        }
        break
      case TYPE_PTR:
        records.push({ name, type, data: readName(buffer, rdStart).name })
        break
      case TYPE_SRV: {
        const port = buffer.readUInt16BE(rdStart + 4)
        records.push({ name, type, port, data: readName(buffer, rdStart + 6).name })
        break
      }
      case TYPE_TXT: {
        const txt = new Map<string, string>()
        let at = rdStart
        while (at < rdStart + rdLength) {
          const length = buffer.readUInt8(at)
          const entry = buffer.subarray(at + 1, at + 1 + length).toString('utf8')
          const split = entry.indexOf('=')
          if (split > 0) txt.set(entry.slice(0, split), entry.slice(split + 1))
          at += 1 + length
        }
        records.push({ name, type, data: '', txt })
        break
      }
      default:
        break
    }
  }

  return records
}

/**
 * Correlate records into devices.
 *
 * A reply is a bag of records that only become a device when joined: SRV gives
 * the port and the host name, A resolves that host, TXT gives the name a person
 * would recognise. A device missing any of those is dropped rather than shown
 * with a blank — a list entry that cannot be connected to is worse than a
 * shorter list.
 */
export function devicesFrom(records: Record[]): DiscoveredDevice[] {
  const addresses = new Map<string, string>()
  for (const record of records) {
    if (record.type === TYPE_A) addresses.set(record.name, record.data)
  }

  const texts = new Map<string, Map<string, string>>()
  for (const record of records) {
    if (record.type === TYPE_TXT && record.txt) texts.set(record.name, record.txt)
  }

  const devices = new Map<string, DiscoveredDevice>()
  for (const record of records) {
    if (record.type !== TYPE_SRV || record.port === undefined) continue

    const address = addresses.get(record.data)
    if (address === undefined) continue

    const txt = texts.get(record.name)
    const instance = record.name.split('.')[0] ?? record.name
    // `id` is the device's own uuid where it publishes one, so reconnecting to
    // "the same TV" survives a name change. The instance name is the fallback
    // and is itself usually that uuid.
    const id = txt?.get('id') ?? instance

    devices.set(id, {
      id,
      name: txt?.get('fn') ?? instance,
      address,
      port: record.port,
    })
  }

  return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/* ── The socket ─────────────────────────────────────────────────────────── */

/**
 * Ask, listen for `timeoutMs`, and report what answered.
 *
 * ## Why two sockets
 *
 * The textbook mDNS client binds port 5353 and reads multicast replies. On a
 * real desktop that port is usually already taken — `avahi-daemon` on Linux,
 * Bonjour on Windows, and on this build machine `adb`, which was holding it
 * when discovery was first tried here and returned an empty list while `avahi`
 * could see the network perfectly well. A client that only does that reports
 * "no televisions" on exactly the machines most likely to have one.
 *
 * So there are two attempts and their results are merged:
 *
 * - an **ephemeral** socket, whose query sets the QU bit asking responders to
 *   answer it directly. This is the one that works when 5353 is taken, and it
 *   is why `buildQuery` has that parameter at all.
 * - a socket **on 5353** with `reuseAddr` and group membership, for responders
 *   that ignore QU and only ever answer the group. It is allowed to fail; when
 *   the port is held by another process this is the half that goes quiet.
 *
 * Neither alone is reliable, which is the whole argument for doing both.
 *
 * ## Never rejects
 *
 * No route to the group, a firewall eating 5353, a container without
 * multicast — all mean "no televisions found", which the user reads in the
 * picker, and none is something the caller can act on beyond saying so.
 *
 * The query goes out three times because mDNS is UDP and one lost packet would
 * otherwise read as an empty network.
 */
export function discover(timeoutMs = 3000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const records: Record[] = []
    const sockets: ReturnType<typeof createSocket>[] = []
    let settled = false

    const collect = (message: Buffer): void => {
      try {
        records.push(...parseResponse(message))
      } catch {
        // One malformed reply must not lose the well-formed ones.
      }
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {
          // Already closed; the result is unaffected.
        }
      }
      resolve(devicesFrom(records))
    }

    /** Send `query` three times over `seconds`, so one lost packet is not fatal. */
    const askRepeatedly = (socket: ReturnType<typeof createSocket>, query: Buffer): void => {
      const send = (): void => {
        if (settled) return
        socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {
          // Errors here are routine on a machine with several interfaces.
        })
      }
      send()
      setTimeout(send, 250)
      setTimeout(send, 750)
    }

    // 1. Ephemeral, asking for a unicast answer. Works when 5353 is taken.
    const direct = createSocket({ type: 'udp4', reuseAddr: true })
    sockets.push(direct)
    direct.on('error', () => {})
    direct.on('message', collect)
    direct.bind(0, () => {
      try {
        direct.setMulticastTTL(255)
      } catch {
        // Not fatal: the default TTL reaches the local segment, which is where
        // a television on the same network is.
      }
      askRepeatedly(direct, buildQuery(CAST_SERVICE, true))
    })

    // 2. The conventional socket, for responders that only answer the group.
    const grouped = createSocket({ type: 'udp4', reuseAddr: true })
    sockets.push(grouped)
    grouped.on('error', () => {
      // Almost always EADDRINUSE from another mDNS stack. The socket above is
      // the answer to that, so this is expected rather than exceptional.
    })
    grouped.on('message', collect)
    try {
      grouped.bind(MDNS_PORT, () => {
        try {
          grouped.addMembership(MDNS_ADDRESS)
        } catch {
          // Some interfaces refuse; the query may still be answered.
        }
        askRepeatedly(grouped, buildQuery(CAST_SERVICE, false))
      })
    } catch {
      // Bind threw synchronously. Discovery continues on the ephemeral socket.
    }

    setTimeout(finish, timeoutMs)
  })
}
