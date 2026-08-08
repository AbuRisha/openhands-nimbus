import { describe, it, expect } from "vitest";
import { reconnectDelay } from "#/hooks/use-websocket";

/**
 * The bug this closes: a tab whose conversation was deleted retried the events
 * socket every ~3s indefinitely, with no backoff and no give-up.
 *
 * The browser never exposes the HTTP rejection to JS — a handshake refused with
 * 403 arrives as close code 1006, which is indistinguishable BY CODE from a
 * mid-session network blip. So the fix cannot key on the code; it keys on
 * whether the socket ever opened, plus backoff for everything else.
 */
describe("reconnectDelay", () => {
  it("starts at the original fixed delay", () => {
    // Attempt 1 must not be slower than before — a real blip should still
    // recover about as fast as it used to.
    expect(reconnectDelay(1)).toBe(3000);
  });

  it("doubles each attempt", () => {
    expect(reconnectDelay(2)).toBe(6000);
    expect(reconnectDelay(3)).toBe(12000);
    expect(reconnectDelay(4)).toBe(24000);
  });

  it("caps so a long outage does not drift to hours", () => {
    expect(reconnectDelay(5)).toBe(30000);
    expect(reconnectDelay(50)).toBe(30000);
  });

  it("never returns a delay below the base", () => {
    // Defensive: attempt 0 or a negative would otherwise compute a fraction of
    // the base and hammer harder than the original bug.
    expect(reconnectDelay(0)).toBe(3000);
    expect(reconnectDelay(-5)).toBe(3000);
  });

  /**
   * The load argument, made concrete. Twenty attempts is the configured bound
   * for a socket that HAS opened; the point of backoff is what that costs the
   * server per stranded tab.
   */
  it("cuts total requests over ten minutes dramatically", () => {
    const WINDOW_MS = 10 * 60 * 1000;

    let fixed = 0;
    for (let t = 0; t < WINDOW_MS; t += 3000) fixed += 1;

    let backed = 0;
    let elapsed = 0;
    let attempt = 1;
    while (elapsed < WINDOW_MS) {
      elapsed += reconnectDelay(attempt);
      attempt += 1;
      backed += 1;
    }

    expect(fixed).toBe(200);
    // ~22 rather than 200: the same tab, an order of magnitude less traffic.
    expect(backed).toBeLessThan(30);
  });
});
