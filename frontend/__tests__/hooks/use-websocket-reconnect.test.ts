/**
 * Reconnection policy for `useWebSocket`.
 *
 * Driven by a hand-rolled WebSocket double rather than MSW on purpose. The
 * assertions here are about WHEN a socket is constructed and HOW MANY times,
 * which needs deterministic control of both the close code and the clock —
 * and the MSW-based suite next door is documented as cross-contaminating when
 * run in parallel (see the header of use-websocket.test.ts).
 *
 * The bug being pinned: an authentication rejection retried forever. Two
 * conversations cycling every few seconds produced 38 rejected handshakes in a
 * 200-line log tail, because a permanent failure was indistinguishable from a
 * dropped connection and the retry budget was Infinity at a flat 3s.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useWebSocket } from "#/hooks/use-websocket";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  HANDSHAKE_MAX_ATTEMPTS,
  HANDSHAKE_BASE_DELAY_MS,
} from "#/utils/websocket-close";

class FakeWebSocket {
  static readonly CONNECTING = 0;

  static readonly OPEN = 1;

  static readonly CLOSING = 2;

  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  static get latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  url: string;

  readyState: number = FakeWebSocket.CONNECTING;

  onopen: ((event: Event) => void) | null = null;

  onclose: ((event: CloseEvent) => void) | null = null;

  onmessage: ((event: MessageEvent) => void) | null = null;

  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();

  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  /** The server accepted the handshake. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** The server (or the network) ended it. */
  emitClose(code: number, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

const RealWebSocket = globalThis.WebSocket;

const URL = "ws://acme.com/sockets/events/1";

/** Close the live socket and let any scheduled retry fire. */
const closeAndAdvance = async (code: number, ms: number, reason = "") => {
  await act(async () => {
    FakeWebSocket.latest.emitClose(code, reason);
  });
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

/**
 * Complete the handshake.
 *
 * Load-bearing in every "had opened" test below: a socket that never opened
 * takes the refused-handshake path, which is a DIFFERENT budget and a
 * different terminal state. Tests that skip this are testing the backstop
 * while appearing to test reconnection.
 */
const open = async () => {
  await act(async () => {
    FakeWebSocket.latest.open();
  });
};

describe("useWebSocket reconnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", RealWebSocket);
  });

  describe("a permanent authentication rejection", () => {
    it("does not reconnect even once", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );
      expect(FakeWebSocket.instances).toHaveLength(1);

      await act(async () => {
        FakeWebSocket.latest.emitClose(1008, "invalid session key");
      });

      // Well past every backoff step, and past the flat 3s this replaced.
      await act(async () => {
        vi.advanceTimersByTime(300_000);
      });

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(result.current.isReconnecting).toBe(false);
    });

    it("surfaces the expired state instead of a retry spinner", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      await act(async () => {
        FakeWebSocket.latest.emitClose(1008, "invalid session key");
      });

      expect(result.current.failureReason).toBe("session-expired");
      expect(result.current.isSessionExpired).toBe(true);
      expect(result.current.isConnected).toBe(false);
    });

    it("reports the rejection rather than a bare close code", async () => {
      // The old message was "WebSocket closed with code 1008: ", repeated
      // every three seconds forever, and named nothing the user could do.
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      await act(async () => {
        FakeWebSocket.latest.emitClose(1008, "invalid session key");
      });

      expect(result.current.error?.message).toContain("rejected the session");
      expect(result.current.error?.message).toContain("invalid session key");
    });

    it("routes to onPermanentClose and NOT to onError", async () => {
      const onPermanentClose = vi.fn();
      const onError = vi.fn();
      const onClose = vi.fn();

      renderHook(() =>
        useWebSocket(URL, {
          reconnect: { enabled: true },
          onPermanentClose,
          onError,
          onClose,
        }),
      );

      await act(async () => {
        FakeWebSocket.latest.emitClose(1008, "invalid session key");
      });

      expect(onPermanentClose).toHaveBeenCalledOnce();
      // Sharing the error channel is what let the caller show "Failed to
      // connect to server" on a loop for something reconnecting cannot fix.
      expect(onError).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("applies to the application auth codes too", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      await act(async () => {
        FakeWebSocket.latest.emitClose(4401, "session expired");
      });
      await act(async () => {
        vi.advanceTimersByTime(300_000);
      });

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(result.current.failureReason).toBe("session-expired");
    });
  });

  describe("a transient close on a connection that HAD opened", () => {
    it("retries on an exponential backoff", async () => {
      renderHook(() => useWebSocket(URL, { reconnect: { enabled: true } }));
      await open();

      // 1s, 2s, 4s, 8s — asserted a millisecond either side of each step, so a
      // regression to the old flat 3s fails rather than merely running slower.
      const steps = [1000, 2000, 4000, 8000];
      for (let i = 0; i < steps.length; i += 1) {
        const expected = FakeWebSocket.instances.length + 1;

        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, steps[i] - 1, "Connection failed");
        expect(FakeWebSocket.instances).toHaveLength(expected - 1);

        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          vi.advanceTimersByTime(1);
        });
        expect(FakeWebSocket.instances).toHaveLength(expected);
      }
    });

    it("gives up at the attempt cap instead of retrying forever", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );
      await open();

      // Enough clock for every step, including the 30s ceiling.
      for (let i = 0; i < DEFAULT_MAX_RECONNECT_ATTEMPTS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      expect(FakeWebSocket.instances).toHaveLength(
        DEFAULT_MAX_RECONNECT_ATTEMPTS + 1,
      );

      // The one that exhausts the budget.
      await closeAndAdvance(1006, 600_000, "Connection failed");

      expect(FakeWebSocket.instances).toHaveLength(
        DEFAULT_MAX_RECONNECT_ATTEMPTS + 1,
      );
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.failureReason).toBe("unreachable");
      // Distinct from an auth rejection: this one is worth retrying by hand.
      expect(result.current.isSessionExpired).toBe(false);
    });

    it("honours a caller-supplied cap", async () => {
      renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true, maxAttempts: 2 } }),
      );
      await open();

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it("restores the full budget after a successful connection", async () => {
      // Otherwise a session that reconnects fine twice a day eventually
      // exhausts a cap it should never have been accumulating against.
      renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true, maxAttempts: 2 } }),
      );
      await open();

      await closeAndAdvance(1006, 60_000, "Connection failed");
      expect(FakeWebSocket.instances).toHaveLength(2);

      await open();

      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      // 2 fresh attempts after the reset, not 1 left over from before.
      expect(FakeWebSocket.instances).toHaveLength(4);
    });

    it("clears the failure state once a retry connects", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true, maxAttempts: 1 } }),
      );
      await open();

      await closeAndAdvance(1006, 60_000, "Connection failed");
      await closeAndAdvance(1006, 60_000, "Connection failed");
      expect(result.current.failureReason).toBe("unreachable");

      // A later render with a live socket must not keep showing the failure.
      await open();

      expect(result.current.failureReason).toBe(null);
      expect(result.current.isConnected).toBe(true);
    });

    it("does not reconnect when reconnection is disabled", async () => {
      const { result } = renderHook(() => useWebSocket(URL));

      await closeAndAdvance(1006, 600_000, "Connection failed");

      expect(FakeWebSocket.instances).toHaveLength(1);
      // Nothing was going to retry, so there is no budget to have exhausted.
      expect(result.current.failureReason).toBe(null);
    });
  });

  describe("a handshake that never opened", () => {
    /**
     * The backstop for what the server fix cannot reach.
     *
     * `proxy_events_socket` now closes AFTER accepting, so its rejections
     * arrive as a real 1008 and never land here. What still lands here: a
     * websocket path matching no route (it falls through to the SPA
     * StaticFiles mount, whose __call__ asserts an http scope), and any 403
     * from in front of the app server. Both reach the browser as 1006, which
     * carries no information, so the never-opened fact is the only signal.
     */
    it("stops after the handshake budget, not the full one", async () => {
      renderHook(() => useWebSocket(URL, { reconnect: { enabled: true } }));

      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 600_000, "Connection failed");
      }

      expect(FakeWebSocket.instances).toHaveLength(HANDSHAKE_MAX_ATTEMPTS + 1);
      expect(HANDSHAKE_MAX_ATTEMPTS).toBeLessThan(
        DEFAULT_MAX_RECONNECT_ATTEMPTS,
      );
    });

    it("surfaces the reload prompt rather than failing silently", async () => {
      // The whole point. Six silent attempts and no banner is what the
      // reconciliation left behind when the heuristic was dropped.
      const onPermanentClose = vi.fn();
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true }, onPermanentClose }),
      );

      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 600_000, "Connection failed");
      }

      expect(result.current.isSessionExpired).toBe(true);
      expect(onPermanentClose).toHaveBeenCalledOnce();
    });

    it("waits longer between tries than an established connection would", async () => {
      // 3s/6s/12s, not 1s/2s/4s. A cold sandbox must not be called dead in
      // seven seconds.
      renderHook(() => useWebSocket(URL, { reconnect: { enabled: true } }));

      await closeAndAdvance(1006, HANDSHAKE_BASE_DELAY_MS - 1);
      expect(FakeWebSocket.instances).toHaveLength(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("does not fire until the budget is actually spent", async () => {
      // A single failed attempt is not evidence of anything.
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      await closeAndAdvance(1006, 600_000, "Connection failed");

      expect(result.current.isSessionExpired).toBe(false);
      expect(result.current.isReconnecting).toBe(true);
    });

    it("hands the budget back once the socket finally opens", async () => {
      // A slow start must not leave a permanently shortened budget behind.
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      await closeAndAdvance(1006, 600_000, "Connection failed");
      await open();

      for (let i = 0; i < DEFAULT_MAX_RECONNECT_ATTEMPTS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 600_000, "Connection failed");
      }

      // Full budget, and the established-connection terminal state.
      expect(FakeWebSocket.instances).toHaveLength(
        DEFAULT_MAX_RECONNECT_ATTEMPTS + 2,
      );
      await closeAndAdvance(1006, 600_000, "Connection failed");
      expect(result.current.failureReason).toBe("unreachable");
    });
  });

  it("does not retry after unmount", async () => {
    const { unmount } = renderHook(() =>
      useWebSocket(URL, { reconnect: { enabled: true } }),
    );
    const socket = FakeWebSocket.latest;

    unmount();
    await act(async () => {
      socket.emitClose(1006, "Connection failed");
      vi.advanceTimersByTime(600_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
