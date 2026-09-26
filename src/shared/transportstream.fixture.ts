/**
 * Real MPEG-TS segment openings, for `transportstream.test.ts`.
 *
 * Made by ffmpeg (libx264, libx265, aac) rather than by hand, for the same
 * reason as `initsegment.fixture.ts`: the reader is checked against what an
 * encoder writes, not against the reader's own idea of H.264. Each is the start
 * of a `-f mpegts` file, cut two packets after the one holding the SPS — the
 * PAT, the PMT and the first keyframe's headers, which is all a capped read of
 * a real segment needs to reach. For example:
 *
 *     ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=24 -f lavfi -i sine -t 1 \
 *       -pix_fmt yuv420p -c:v libx264 -profile:v high -c:a aac -f mpegts out.ts
 */

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'))

/** H.264 High, 1920x1080, with an audio stream: coded as 1088 and cropped by 8 rows. */
export const TS_H264_1080 = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArAXAAHBAADhAPAAG+EA8AAP4QHwAC9EuZv/////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgMAKMQAJEvkRAAfYYQAAAAEJ' +
  '8AAAAAFnZAAorNlAeAIn5cBEAAADAAQAAAMAwDxgxlgAAAABaOvjyyLAAAABBgX//6vcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNv' +
  'cmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDov' +
  'L3dHAQARd3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFs' +
  'eXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2' +
  'IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZQ==',
)

/** H.264 Constrained Baseline, 1280x720: an SPS without the High-profile fields. */
export const TS_H264_720_BASELINE = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAAB' +
  'Z0LAH9oBQBbsBEAAAAMAQAAADAPGDKgAAAABaM4PyAAAAQYF//9R3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIy' +
  'MiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9s' +
  'YW5HAQARLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9' +
  'ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVs' +
  'bGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdA==',
)

/** H.264 High, 1920x800: a letterboxed film, 50 macroblocks tall and not cropped. */
export const TS_H264_1920X800 = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgMAKMQAJEvkRAAfYYQAAAAEJ' +
  '8AAAAAFnZAAorNlAeAZbARAAAAMAEAAAAwMA8YMZYAAAAAFo6+PLOUcCoMgmBWOBOCoE44EwKwcAnHEo4FQZBMCscCcFQJxwJgVg' +
  '4BOOJQsDYMguBuFgXg2BeGQXAuBuC4CeDYF4NgXg2DINwXAuBuC4G4WBeDYF4NgXg2BeFgbguBcDcFwNwyDYF4NgXg2CwNwXA3Bc' +
  'GQVHAQAR4NgXhYFwNwyDYLShYGwZBcDcLAvBsC8MguBcDcFwE8GwLwbAvBsGQbguBcDcFwNwsC8GwLwbAvBsC8LA3BcC4G4Lgbhk' +
  'GwLwbAvBsFgbguBuC4MgvBsC8LAuBuGQbBYsAAABBgX//6vcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIz' +
  'NTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZg==',
)

/** H.264 Main, 1920x1080 interlaced: heights counted in field pairs. */
export const TS_H264_1080I = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAAB' +
  'Z01AKPQDwCJ+8BEAAAMAAQAAAwAyHxYuoAAAAAFo3g/IAAABBgX//1PcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIz' +
  'MjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRl' +
  'b2xHAQARYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBt' +
  'ZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRy' +
  'ZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYQ==',
)

/** H.264 High 4:4:4, 1280x536: cropping counted in luma samples, not chroma. */
export const TS_H264_444_1280X536 = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAAB' +
  'Z/QAH5GWgFAEX4nARAAAAwAEAAADAMA8YMqAAAAAAWjODxkgAAABBgX//1HcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1' +
  'IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52' +
  'aWRHAQARZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6' +
  'MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0x' +
  'IHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMQ==',
)

/** AAC only. */
export const TS_AUDIO_ONLY = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArASAAHBAADhAPAAD+EA8AC2m8DZ////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAABwAsVgIAFIQAH2GH/8VBAIP/83ABM' +
  'YXZjNjMuMS4xMDIAAmCsW6lQcialePXj9664ltVJapaVJMk7g6EBBhVy8Xca6S1r2l5jwbtjzur5PFLYMz5L55010jzdzbuLYOUu' +
  'I6+1TbVs2VTtVZ91ViOFY3FXGzaDZsbYsTcrLcs517E47G4q42a4z1Zjo1+avzV+axz62fW1LPUsdGvzWmavzV+fWz62fWz6qfX5' +
  'rDNHAQARWGmzos6K1FailTYzMZmMzGitRWorUWNNjMxmYxMaLOitRWosaLGZjMxiSiSniniiSiXwvkvklElPFPFPFEvkvkvkvvFP' +
  'FPFPFEvkvxRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRcD/8VBAIT/8ATSa2tJNwGzFTCbMVKJ03U2p5+tXw2+NXdf+nH6/VwXep//S' +
  '8/r8cBq5v/+31+/tIavjOhJdBBf4mjAw8eXAfZNO7BYpfDaiYXXBmkcBABLSC7Ync40iHwsXa42CHGxamqmtQQqXVTZzP/G0Ndu/' +
  'rOiQYGu5BISDAwNk7hISEgwMDO7hIScBhzLu4ScaBmQa87vkEhOS/PzA2RmhNhLv8IVYaauI6QZKUUqkjcys2dlUbmlrbbbZNFpF' +
  'KbOZKqqLTOpgb5MDf1kJBiQMDBISSvODGzYSElQbNwYGNhISVvY5osZQkrdgIIMvDhZjl4j7XX94fTZVlX5TokJOTTTJVnJpglLd' +
  '4P/xRwEAE1BAFB/8ARL2LPS2MRdQIdM+a9fOf417NcIpcy4m5EeUiJOpdLoSL8jTukeYftuI8wxGTQ/COa7gc1fVZVwxuy7T978D' +
  'xmwwr1nXVurcayqOcsZ3E4mwxqk4Zk2bNjRUQrFq1a4SHTj5scZmB8MMMJHBpsccZkB68MJHcGpxxmZAf394T/Hw2n39yP8fDaff' +
  '3I/jmMPf3lGb4NLvaCcX//FQQBhf/ADoNizQ+i6GBaGA61WeP/7fz/NHAQAU/5ffi7mblXqVcven9XLVLzW1aqZBPUgv6QY2fo3Q' +
  'RzRlCheLzn3unoPO73++j39D0uboq3Otbpl8l+I+S+YRBQDkiM5wVCR/hUx20loSWAwFDhEsirZuO01c+FTAmzCg4pg2HSsrHz1V' +
  'ny5G7HfFh6lcHE/QjC7m2EFQzgzSiB1/sl3sEzpp6bZvtjw/VtxzAkvhhmQmcoYZBBdmctv/dbVsP6DEmReA//FQQBv//ADmNizx' +
  'PQwLRg==',
)

/** HEVC, 1280x720: listed in the PMT as stream type 0x24. */
export const TS_HEVC_720 = bytes(
  'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL/////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/0dQABAAArAYAAHBAADhAPAAJOEA8AYFBEhFVkPLngBS////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgMAKMQAJEvkRAAfYYQAAAAFG' +
  'AVAAAAABQAEMAf//BAgAAAMAnggAAAMAAF2VlAkAAAABQgEBBAgAAAMAnggAAAMAAF2QAFAQBaLLKypSYXgLcCAgAEAAAAMAQAAA' +
  'BgIAAAABRAHAcxgwGJAAAAFOAQX///////////8DLKLeCbUXR9u7VaT+f8L8TngyNjUgKGJ1aWxkIDIxNykgLSA0LjM6W0xpbnV4' +
  'XVtHAQARR0NDIDE2LjEuMV1bNjQgYml0XSA4Yml0KzEwYml0KzEyYml0IC0gSC4yNjUvSEVWQyBjb2RlYyAtIENvcHlyaWdodCAy' +
  'MDEzLTIwMTggKGMpIE11bHRpY29yZXdhcmUsIEluYyAtIGh0dHA6Ly94MjY1Lm9yZyAtIG9wdGlvbnM6IGNwdWlkPTExMTEwMzkg' +
  'ZnJhbWUtdGhyZWFkcz00IHdwcCBuby1wbW9kZSBuby1wbWUgbm8tcEcBABJzbnIgbm8tc3NpbSBsb2ctbGV2ZWw9LTEgYml0ZGVw' +
  'dGg9OCBpbnB1dC1jc3A9MyBmcHM9MjQvMSBpbnB1dC1yZXM9MTI4MHg3MjAgaW50ZXJsYWNlPTAgdG90YWwtZnJhbWVzPTAgbGV2' +
  'ZWwtaWRjPTAgaGlnaC10aWVyPTEgdWhkLWJkPTAgcmVmPTEgbm8tYWxsb3ctbm9uLWNvbmZvcm1hbmNlIHJlcGVhdC1oZWFkZXJz' +
  'IGFuRwEAE25leGIgbm8tYXVkIG5vLWVvYiBuby1lb3Mgbm8taHJkIGluZm8gaGFzaD0wIHRlbXBvcmFsLWxheWVycz0wIG9wZW4t' +
  'Z29wIG1pbi1rZXlpbnQ9MjQga2V5aW50PTI1MCBnb3AtbG9va2FoZWFkPTAgYmZyYW1lcz0zIGItYWRhcHQ9MCBiLXB5cmFtaWQg' +
  'YmZyYW1lLWJpYXM9MCByYy1sb29rYWhlYWQ9NSBsb29rYWhlYWQtc2xHAQAUaWNlcz00IHNjZW5lY3V0PTAgbm8taGlzdC1zY2Vu' +
  'ZWN1dCByYWRsPTAgbm8tc3BsaWNlIG5vLWludHJhLXJlZnJlc2ggY3R1PTMyIG1pbi1jdS1zaXplPTE2IG5vLXJlY3Qgbm8tYW1w' +
  'IG1heC10dS1zaXplPTMyIHR1LWludGVyLWRlcHRoPTEgdHUtaW50cmEtZGVwdGg9MSBsaW1pdC10dT0wIHJkb3EtbGV2ZWw9MCBk' +
  'eW5hbQ==',
)

/**
 * An H.264 SPS (after its NAL header byte) that carries scaling lists: 1920x800,
 * High, with lists 0, 3 (4x4) and 6 (8x8) present.
 *
 * Built by hand, because x264 writes custom matrices into the PPS and never the
 * SPS. Checked with ffmpeg's own parser rather than this one's
 * (`-bsf:v trace_headers`), which reads the same lists and the same 120x50
 * macroblocks.
 */
export const SPS_WITH_SCALING_LISTS = Uint8Array.from(
  Buffer.from(
    '640028ad9470e1c387010c70e1c387010c70e1c50e1c3870e0218e1c387010c70e1c38881c3870e0218e1c3870e0218e1c38' +
      '70e0218e1c387010c70e1c387010c70e1c387010c70e1c387010c70e1c380863870e1c380863870e1c380863870e1c0431cd9' +
      '407806590',
    'hex',
  ),
)
