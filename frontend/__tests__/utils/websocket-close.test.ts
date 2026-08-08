import { describe, it, expect } from "vitest";
import {
  classifyCloseCode,
  describeCloseEvent,
  getReconnectDelayMs,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_AUTH_EXPIRED,
  WS_CLOSE_AUTH_FORBIDDEN,
} from "#/utils/websocket-close";

describe("classifyCloseCode", () => {
  it("treats a policy violation as permanent", () => {
    // What the agent proxy sends when validate_session_key refuses.
    expect(classifyCloseCode(WS_CLOSE_POLICY_VIOLATION)).toBe("permanent");
  });

  it.each([WS_CLOSE_AUTH_EXPIRED, WS_CLOSE_AUTH_FORBIDDEN])(
    "treats the application auth code %i as permanent",
    (code) => {
      expect(classifyCloseCode(code)).toBe("permanent");
    },
  );

  it("treats a normal closure as normal", () => {
    expect(classifyCloseCode(1000)).toBe("normal");
  });

  it.each([
    [1001, "going away"],
    [1006, "abnormal — a dropped connection, or a refused handshake"],
    [1012, "service restart"],
    [1013, "try again later"],
  ])("treats %i (%s) as transient", (code) => {
    expect(classifyCloseCode(code)).toBe("transient");
  });

  it("treats 1011 as transient, not permanent", () => {
    // An unhandled exception upstream is the most recoverable thing a server
    // does. Classifying it permanent would strand a session over a stack trace.
    expect(classifyCloseCode(1011)).toBe("transient");
  });

  it("treats an unrecognised application code as transient", () => {
    // Fail toward retrying: a few wasted attempts beat refusing to reconnect
    // because a future server sent a code this build has never seen.
    expect(classifyCloseCode(4999)).toBe("transient");
  });
});

describe("getReconnectDelayMs", () => {
  it("doubles from one second", () => {
    expect([1, 2, 3, 4, 5].map((n) => getReconnectDelayMs(n))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
  });

  it("stops doubling at the ceiling", () => {
    expect(getReconnectDelayMs(6)).toBe(DEFAULT_RECONNECT_MAX_DELAY_MS);
    expect(getReconnectDelayMs(40)).toBe(DEFAULT_RECONNECT_MAX_DELAY_MS);
  });

  it("honours a caller-supplied base and ceiling", () => {
    const options = { baseDelayMs: 50, maxDelayMs: 120 };
    expect([1, 2, 3, 4].map((n) => getReconnectDelayMs(n, options))).toEqual([
      50, 100, 120, 120,
    ]);
  });

  it("never returns a delay shorter than the first step", () => {
    // A 0th or negative attempt must not schedule an immediate retry loop.
    expect(getReconnectDelayMs(0)).toBe(1000);
    expect(getReconnectDelayMs(-3)).toBe(1000);
  });
});

describe("describeCloseEvent", () => {
  it("says the session was rejected for a permanent close", () => {
    const message = describeCloseEvent(1008, "invalid session key");

    expect(message).toContain("rejected the session");
    expect(message).toContain("invalid session key");
  });

  it("still reports the raw code for a transient close", () => {
    expect(describeCloseEvent(1006, "Connection failed")).toBe(
      "WebSocket closed with code 1006: Connection failed",
    );
  });

  it("falls back to a description when the server sends no reason", () => {
    expect(describeCloseEvent(1006)).toContain(
      "Connection closed unexpectedly",
    );
    expect(describeCloseEvent(1008)).toContain("no longer valid");
  });
});
