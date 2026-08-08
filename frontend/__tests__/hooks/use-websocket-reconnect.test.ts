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
import { DEFAULT_MAX_RECONNECT_ATTEMPTS } from "#/utils/websocket-close";

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

  /*
   * THE PATH THAT ACTUALLY FIRES AGAINST THE DEPLOYED BACKEND.
   *
   * The accept-then-close change that lets 1008 reach a browser is on
   * lane/backend and in no build. Production rejects BEFORE accept, so uvicorn
   * answers the upgrade with an HTTP status, the handshake never completes,
   * and the browser synthesises 1006 — indistinguishable from an unreachable
   * server. A frontend that classifies only by close code is dead code against
   * the server that is actually running.
   */
  describe("a handshake that never completed", () => {
    it("gives up after HANDSHAKE_MAX_ATTEMPTS, not the full budget", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      // No open() anywhere: the socket is refused every time.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      // 3 retries + the original = 4 sockets. Twenty attempts at a structural
      // refusal is twenty ways of saying nothing.
      expect(FakeWebSocket.instances).toHaveLength(4);
      expect(result.current.failureReason).toBe("handshake-refused");
    });

    it("does NOT claim the session expired", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      /*
       * 1006 covers BOTH a refused upgrade and a pulled network cable. Saying
       * "your session expired" to the second case is a specific untrue
       * statement about someone's account, so the reason stays distinct from
       * `session-expired` and the copy names no cause.
       */
      expect(result.current.failureReason).not.toBe("session-expired");
      expect(result.current.isSessionExpired).toBe(false);
    });

    it("tells the caller, so a banner can offer the reload", async () => {
      const onHandshakeRefused = vi.fn();
      renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true }, onHandshakeRefused }),
      );

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      // Exactly once — on the close that spends the budget, not on each retry.
      expect(onHandshakeRefused).toHaveBeenCalledTimes(1);
    });

    it("a socket that opened ONCE gets the full budget afterwards", async () => {
      const { result } = renderHook(() =>
        useWebSocket(URL, { reconnect: { enabled: true } }),
      );
      await act(async () => {
        FakeWebSocket.latest.open();
      });

      // Four closes would have exhausted the handshake budget; having opened,
      // this is a mid-session drop and keeps retrying.
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await closeAndAdvance(1006, 60_000, "Connection failed");
      }

      expect(FakeWebSocket.instances.length).toBeGreaterThan(4);
      expect(result.current.failureReason).toBeNull();
    });
  });

  describe("a transient close", () => {
    /*
     * Every test here OPENS the socket first. "Transient" means a drop
     * mid-session, and a socket that never opened is a different failure with
     * a different budget (HANDSHAKE_MAX_ATTEMPTS) and a different reason
     * (`handshake-refused`) — see the block below. Without this the tests were
     * asserting the handshake path under a name that promised the other one.
     */
    it("retries on an exponential backoff", async () => {
      renderHook(() => useWebSocket(URL, { reconnect: { enabled: true } }));
      await act(async () => {
        FakeWebSocket.latest.open();
      });

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
      await act(async () => {
        FakeWebSocket.latest.open();
      });

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

      await closeAndAdvance(1006, 60_000, "Connection failed");
      expect(FakeWebSocket.instances).toHaveLength(2);

      await act(async () => {
        FakeWebSocket.latest.open();
      });

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
      await act(async () => {
        FakeWebSocket.latest.open();
      });

      await closeAndAdvance(1006, 60_000, "Connection failed");
      await closeAndAdvance(1006, 60_000, "Connection failed");
      expect(result.current.failureReason).toBe("unreachable");

      // A later render with a live socket must not keep showing the failure.
      await act(async () => {
        FakeWebSocket.latest.open();
      });

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
