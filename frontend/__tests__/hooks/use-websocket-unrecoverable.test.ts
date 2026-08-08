import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket } from "#/hooks/use-websocket";

/**
 * A deploy strands every open chat tab.
 *
 * `process_sandbox_service._processes` is a module-level in-memory dict and the
 * sandbox is a CHILD PROCESS of the app container, so a revision swap kills
 * both — every previously minted `session_api_key` becomes permanently
 * unvalidatable. `agent_proxy_router` then closes the events socket with 1008
 * POLICY_VIOLATION before accept.
 *
 * The client used to retry that forever: `maxAttempts` defaulted to Infinity and
 * both call sites pass only `{ enabled: true }`. The user saw a chat that never
 * reconnected, with nothing saying to reload — and reload is the only fix.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((e: Event) => void) | null = null;

  onclose: ((e: CloseEvent) => void) | null = null;

  onmessage: ((e: MessageEvent) => void) | null = null;

  onerror: ((e: Event) => void) | null = null;

  readyState = 0;

  close = vi.fn();

  send = vi.fn();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** `code` is what the server actually sent — 1008 for a dead session key. */
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "", wasClean: false } as CloseEvent);
  }
}

const latest = () =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = (opts = {}) =>
  renderHook(() =>
    useWebSocket("ws://test/sockets/events/1", {
      reconnect: { enabled: true },
      ...opts,
    }),
  );

describe("useWebSocket terminal closes", () => {
  it("does NOT retry a 1008 policy violation", () => {
    // THE BUG. A dead session key cannot be revived, so every retry is futile.
    const { result } = mount();
    act(() => latest().open());
    const before = FakeWebSocket.instances.length;

    act(() => latest().serverClose(1008));
    act(() => vi.advanceTimersByTime(30_000));

    expect(FakeWebSocket.instances.length).toBe(before);
    expect(result.current.isUnrecoverable).toBe(true);
  });

  it("calls onUnrecoverable so the UI can say to reload", () => {
    const onUnrecoverable = vi.fn();
    mount({ onUnrecoverable });
    act(() => latest().open());

    act(() => latest().serverClose(1008));

    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(onUnrecoverable.mock.calls[0][0].code).toBe(1008);
  });

  it.each([1000, 1001])("treats %i as terminal too", (code) => {
    // Normal / going-away: the peer closed deliberately.
    const { result } = mount();
    act(() => latest().open());
    const before = FakeWebSocket.instances.length;

    act(() => latest().serverClose(code));
    act(() => vi.advanceTimersByTime(30_000));

    expect(FakeWebSocket.instances.length).toBe(before);
    expect(result.current.isUnrecoverable).toBe(true);
  });

  it("STILL retries a transient close", () => {
    // The fix must not break ordinary reconnection — 1006 abnormal is exactly
    // the case reconnecting exists for.
    mount();
    act(() => latest().open());
    const before = FakeWebSocket.instances.length;

    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(3_100));

    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it("stops after the default attempt bound rather than forever", () => {
    // Infinity was the old default. An unbounded retry with nothing surfaced is
    // indistinguishable from a hung UI.
    const { result } = mount();
    act(() => latest().open());

    for (let i = 0; i < 25; i += 1) {
      act(() => latest().serverClose(1006));
      act(() => vi.advanceTimersByTime(3_100));
    }

    // 20 retries + the original socket.
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(21);
    expect(result.current.isUnrecoverable).toBe(true);
  });

  it("clears the flag when a later connection succeeds", () => {
    const { result } = mount();
    act(() => latest().open());
    act(() => latest().serverClose(1006));
    act(() => vi.advanceTimersByTime(3_100));

    act(() => latest().open());

    expect(result.current.isUnrecoverable).toBe(false);
  });
});
