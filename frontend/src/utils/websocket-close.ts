/**
 * Close-code policy for the conversation event socket.
 *
 * The distinction that matters for reconnection is not "clean vs unclean" but
 * "could another attempt ever succeed". An expired or unrecognised session key
 * is rejected identically every time, so retrying it is a busy loop with no
 * terminating condition — production logged 38 rejected handshakes in a
 * 200-line tail, two conversations cycling every few seconds indefinitely.
 *
 * The permanent set is deliberately small. Anything not listed retries,
 * because failing open on this classification costs a few wasted attempts
 * while failing closed strands a session that would have recovered on its own.
 */

/** Standard policy violation. What the proxy sends for a bad session key. */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * Application close codes. 4000-4999 is the range reserved for applications;
 * these mirror the HTTP statuses they stand in for so a reader does not have
 * to look them up. Nothing sends them today — they are here so that a future
 * server that wants to say "expired" rather than "policy" does not have to
 * touch the client to be understood.
 */
export const WS_CLOSE_AUTH_EXPIRED = 4401;
export const WS_CLOSE_AUTH_FORBIDDEN = 4403;

/** Normal closure. Not a failure at all. */
const WS_CLOSE_NORMAL = 1000;

const PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_AUTH_EXPIRED,
  WS_CLOSE_AUTH_FORBIDDEN,
]);

export type WebSocketClosureKind = "normal" | "permanent" | "transient";

/**
 * 1011 (internal error) is NOT in the permanent set on purpose: an unhandled
 * exception upstream is the single most recoverable thing a server does, and
 * nothing in this application closes with it. 1006 (abnormal) is likewise
 * transient — it is what a browser reports for a dropped connection, and it is
 * also what it reports for a handshake the server refused, which is precisely
 * why the server has to close AFTER accepting for 1008 to survive the trip.
 */
export function classifyCloseCode(code: number): WebSocketClosureKind {
  if (code === WS_CLOSE_NORMAL) return "normal";
  if (PERMANENT_CLOSE_CODES.has(code)) return "permanent";
  return "transient";
}

/** Attempts before giving up on a transient failure. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;

/** First backoff step. Doubles from here. */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;

/** Ceiling for the doubling, so attempt 20 does not schedule itself for next week. */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

/**
 * Attempts allowed when the socket has NEVER opened.
 *
 * A never-opened close is a REFUSED HANDSHAKE, and the browser reports it as
 * 1006 — the same code as a yanked cable — because a handshake that never
 * completed has no closing frame to carry the server's real code. So a close
 * code cannot classify this case and the never-opened fact has to.
 *
 * This is a BACKSTOP, deliberately narrow. `proxy_events_socket` now closes
 * after accepting, so its rejections arrive as a real 1008 and never reach
 * here. What still lands here is what that fix cannot reach: a websocket path
 * matching no route (it falls to the SPA `StaticFiles` mount, whose `__call__`
 * opens `assert scope["type"] == "http"`), and any 403 from in front of the app
 * server. Both are unactionable by waiting, and both are exactly the case where
 * a reload prompt is the only useful thing to show.
 *
 * Do not widen this into a general "never opened means give up" rule — an
 * established connection that drops gets the full budget, because that one
 * genuinely recovers.
 */
export const HANDSHAKE_MAX_ATTEMPTS = 3;

/**
 * First backoff step for a socket that has never opened.
 *
 * Slower than the general 1s, and fewer attempts: three tries at 3s/6s/12s
 * spans ~21s, which covers a sandbox still coming up. The general base is
 * tuned for a blip on a live connection, where the first retry is usually
 * free; applying it here would call a cold start dead in seven seconds.
 */
export const HANDSHAKE_BASE_DELAY_MS = 3000;

export interface ReconnectDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Exponential backoff for a 1-based attempt number.
 *
 * The flat 3s this replaces made every client hammer at the same rate no
 * matter how long the outage had lasted, which is the behaviour that turned a
 * permanent rejection into a visible load pattern.
 *
 * No jitter: the delays are the assertion in the tests, and a single browser
 * tab holds at most two of these sockets, so spreading them apart buys
 * nothing here. Add jitter if this is ever driven by many sockets at once.
 */
export function getReconnectDelayMs(
  attempt: number,
  options?: ReconnectDelayOptions,
): number {
  const base = options?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const max = options?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(base * 2 ** (step - 1), max);
}

/**
 * The message shown for a close.
 *
 * A permanent rejection gets its own wording because "WebSocket closed with
 * code 1008" tells the person reading it nothing they can act on, and it was
 * previously the ONLY thing they saw — repeated every three seconds forever.
 */
export function describeCloseEvent(code: number, reason?: string): string {
  if (classifyCloseCode(code) === "permanent") {
    return `WebSocket rejected the session (code ${code}): ${
      reason || "the session key is no longer valid"
    }`;
  }
  return `WebSocket closed with code ${code}: ${
    reason || "Connection closed unexpectedly"
  }`;
}
