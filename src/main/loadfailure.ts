/**
 * What a source's failed load is called where the viewer reads it.
 *
 * The player's offer bar used to show Chromium's own code ("ERR_CERT_AUTHORITY_
 * INVALID."), which tells the viewer nothing but that something is wrong.
 * Reported 2026-10-04 with Videasy, whose site had started answering with a
 * self-signed certificate (DDoS-Guard's): every browser refuses it, nothing in
 * the app can or should get past it, and the bar should say so in words.
 *
 * Codes are Chromium's (`net/base/net_error_list.h`). Anything not listed keeps
 * Chromium's own text, which is at least searchable.
 */

/** Certificate errors are Chromium's -200 to -299, all of them. */
const isCertificateError = (code: number): boolean => code <= -200 && code >= -299

const PLAIN: Record<number, (source: string) => string> = {
  [-7]: (source) => `${source} did not answer in time`,
  [-21]: () => 'The network changed while loading',
  [-27]: (source) => `${source} refuses to be shown inside another app`,
  [-100]: (source) => `${source} closed the connection`,
  [-101]: (source) => `The connection to ${source} was cut`,
  [-102]: (source) => `${source} refused the connection`,
  [-109]: (source) => `${source} cannot be reached`,
  [-118]: (source) => `${source} did not answer in time`,
  [-137]: (source) => `${source}'s address could not be found`,
}

/** The reason the offer bar and the failure page show for a failed load of `source`. */
export function loadFailureReason(code: number, description: string, source: string): string {
  if (isCertificateError(code)) return `${source}'s site has an invalid security certificate`
  return PLAIN[code]?.(source) ?? description
}
