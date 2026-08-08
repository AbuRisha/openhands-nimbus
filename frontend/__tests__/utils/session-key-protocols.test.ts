import { describe, it, expect } from "vitest";
import {
  SESSION_KEY_SUBPROTOCOL,
  encodeSessionKey,
  sessionKeyProtocols,
} from "#/utils/session-key-protocols";

describe("encodeSessionKey", () => {
  /**
   * The whole point of this module is that the key stops appearing in a URL.
   * These tests are about the ENCODING being legal as a subprotocol token,
   * because an illegal token fails the handshake outright — which would take
   * down every chat session rather than leak one.
   */
  it("strips base64 padding, which is not a legal subprotocol token character", () => {
    // "a" pads to "YQ==", "ab" to "YWI=". Both must come back unpadded.
    expect(encodeSessionKey("a")).not.toContain("=");
    expect(encodeSessionKey("ab")).not.toContain("=");
  });

  it("emits only characters legal in a Sec-WebSocket-Protocol token", () => {
    // RFC 6455 defers to RFC 7230 tokens. base64url is legal EXCEPT '='; the
    // standard alphabet's '+' and '/' are not, which is why this is base64URL.
    const encoded = encodeSessionKey(
      "sk-abcdefghijklmnopqrstuvwxyz0123456789+/=",
    );
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("round-trips through the server's decoder", () => {
    // Mirrors _key_from_subprotocol in agent_proxy_router.py: re-pad, then
    // decode. If these two ever disagree, every socket fails auth.
    const key = "sk-live-9f8e7d6c5b4a";
    const encoded = encodeSessionKey(key);
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toBe(key);
  });

  it("survives a non-ASCII key instead of throwing", () => {
    // btoa throws on any code point above U+00FF. Keys are ASCII today, but a
    // throw here kills the socket at construction, which is a worse failure
    // than the one this module exists to fix.
    expect(() => encodeSessionKey("ключ-🔑")).not.toThrow();
  });
});

describe("sessionKeyProtocols", () => {
  it("puts the marker first so the server can recognise the offer", () => {
    const protocols = sessionKeyProtocols("sk-1");
    expect(protocols?.[0]).toBe(SESSION_KEY_SUBPROTOCOL);
    expect(protocols?.[1]).toBe(encodeSessionKey("sk-1"));
  });

  it("returns undefined — not [] — when there is no key", () => {
    // An empty array still selects the two-argument WebSocket constructor,
    // which offers an empty protocol list rather than none at all.
    expect(sessionKeyProtocols(null)).toBeUndefined();
    expect(sessionKeyProtocols(undefined)).toBeUndefined();
    expect(sessionKeyProtocols("")).toBeUndefined();
  });

  it("never returns the raw key, which is the point", () => {
    const protocols = sessionKeyProtocols("sk-secret-value");
    expect(protocols).not.toContain("sk-secret-value");
  });
});
