/**
 * The shapes cross-device sync is built from.
 *
 * Deliberately small and deliberately free of any platform: everything here is
 * plain data over `fetch`, so the desktop and the phone run the *same* sync
 * rather than two ports of it. The only thing either platform supplies is where
 * to keep a refresh token, which is the one genuinely native concern.
 *
 * The reasoning behind picking Google's device flow lives in the project's
 * sync design notes, which are not published. This file is the contract that
 * design produces, and it is the part that has to be readable on its own.
 */

import type { StoreDocument } from '../store/document'

/* ── OAuth ──────────────────────────────────────────────────────────────── */

/**
 * The app's own OAuth client.
 *
 * The secret ships in the repository, and that is the documented condition of
 * this flow rather than a leak: Google's own page states that "since the
 * applications that use this flow are distributed to individual devices, it is
 * assumed that the apps cannot keep secrets." A fork that would rather not
 * share ours can supply its own pair.
 */
export interface OAuthClient {
  clientId: string
  clientSecret: string
}

/** What the user is asked to type, and where. */
export interface DeviceCodeChallenge {
  /** The short code the user enters, e.g. `WDJB-MJHT`. */
  userCode: string
  /** Where they enter it, e.g. `https://www.google.com/device`. */
  verificationUrl: string
  /** Opaque; the app polls with this, the user never sees it. */
  deviceCode: string
  /** Epoch ms after which the code is dead and a new one is needed. */
  expiresAt: number
  /** Minimum seconds between polls, as dictated by the server. */
  intervalSeconds: number
}

/** A usable credential. `refreshToken` is absent on a refresh response. */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. Treated as expired somewhat early; see `TOKEN_SKEW_MS`. */
  expiresAt: number
}

/**
 * Everything the app keeps between runs.
 *
 * The access token is included even though it is short-lived, so a relaunch
 * inside its lifetime syncs without a round trip to Google first.
 */
export interface StoredCredentials extends OAuthTokens {
  refreshToken: string
  /** For showing *which* account is connected. Never used to identify a user. */
  accountEmail: string | null
}

/* ── Backends ───────────────────────────────────────────────────────────── */

/**
 * What the remote copy looked like when we fetched it.
 *
 * `version` is whatever the backend uses to recognise the same revision again,
 * and it is explicitly allowed to be `null`: **Drive has no conditional
 * update.** `files.update` accepts no `If-Match`, no etag and no revision
 * precondition, so a lost update cannot be prevented at the transport.
 *
 * That is survivable here, and it is worth being precise about why rather than
 * pretending otherwise. The remote file is a *rendezvous, not the record* —
 * every device keeps the whole library locally, and the merge is a union that
 * is idempotent and commutative. If B overwrites A's push from a stale base,
 * B's file is missing A's newest records; A's next sync pulls that file, merges
 * its own copy back in, and pushes the union. Nothing is lost, it is only late.
 *
 * The exception, stated plainly: a device whose local copy is gone — a fresh
 * install, a wiped profile — has nothing to heal from and gets whatever the
 * remote holds.
 */
export interface RemoteDocument {
  document: StoreDocument
  version: string | null
}

export interface SyncBackend {
  /** The remote document, or `null` when this account has never synced. */
  pull(): Promise<RemoteDocument | null>
  /**
   * Replace the remote document.
   *
   * `expected` is the version `pull` returned, offered so a backend that *can*
   * do conditional writes may. Drive cannot and ignores it.
   */
  push(document: StoreDocument, expected: string | null): Promise<void>
}

/* ── Status ─────────────────────────────────────────────────────────────── */

export type SyncState =
  | 'off'
  /** A code is on screen and the app is waiting for the user to enter it. */
  | 'pairing'
  | 'idle'
  | 'syncing'
  | 'error'

export interface SyncStatus {
  state: SyncState
  /** The connected account, for the settings screen. */
  accountEmail: string | null
  /** Epoch ms of the last sync that completed, or null. */
  lastSyncedAt: number | null
  /** Human-readable, and only set when `state` is `error`. */
  error: string | null
  /** Present only while `state` is `pairing`. */
  challenge: Pick<DeviceCodeChallenge, 'userCode' | 'verificationUrl' | 'expiresAt'> | null
}
