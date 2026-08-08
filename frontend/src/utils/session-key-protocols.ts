/**
 * The session key travels as a WebSocket SUBPROTOCOL, not a query parameter.
 *
 * A browser cannot set arbitrary headers on a WS handshake, so the key used to
 * go in the URL — where Azure ingress and Log Analytics record it verbatim, in
 * plaintext, for the retention period. That is a live credential sitting in a
 * log: a replayed key reaches `/api/file/*` on a sandbox where an agent
 * executes code, and a file written into that workspace is a path to execution
 * even though `/api/bash/*` is not proxied.
 *
 * `new WebSocket(url, protocols)` sends `Sec-WebSocket-Protocol` as a REQUEST
 * HEADER, which access logs do not capture. Same secret, same hop, off the URL.
 *
 * The value is base64url with padding STRIPPED: `=` is not a legal subprotocol
 * token character, while the rest of the base64url alphabet is.
 */
export const SESSION_KEY_SUBPROTOCOL = "nimbus-session-key";

/**
 * Encode a key for transport as a subprotocol token.
 *
 * `btoa` throws on any code point above U+00FF, so the key is UTF-8 encoded
 * first rather than passed straight in. Keys are ASCII today; this costs
 * nothing and removes a way for a non-ASCII key to take the socket down.
 */
export const encodeSessionKey = (key: string): string => {
  const utf8 = new TextEncoder().encode(key);
  let binary = "";
  utf8.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * The `protocols` array for a socket, or `undefined` when there is no key.
 *
 * Returning `undefined` rather than `[]` matters: an empty array would still
 * take the two-argument `WebSocket` path, and the caller's job is simply to
 * pass this through.
 */
export const sessionKeyProtocols = (
  key: string | null | undefined,
): string[] | undefined =>
  key ? [SESSION_KEY_SUBPROTOCOL, encodeSessionKey(key)] : undefined;
