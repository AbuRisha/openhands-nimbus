import React from "react";
import {
  classifyCloseCode,
  describeCloseEvent,
  getReconnectDelayMs,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
} from "#/utils/websocket-close";

/**
 * Why the connection stopped, when it stopped for good.
 *
 * `session-expired` is a rejection no retry can fix — the caller has to get a
 * new session key, which in practice means reloading the page. It is only
 * reachable when the server CLOSES AFTER ACCEPTING, because a close code
 * cannot survive a refused upgrade.
 *
 * `handshake-refused` is the same failure seen from a server that rejects
 * BEFORE accepting: the upgrade is answered with an HTTP status, the socket
 * never opens, and the browser reports 1006 — which is also exactly what a
 * pulled network cable looks like. We provably cannot tell those apart from
 * the client, so this reason does not pretend to: see the copy it drives.
 *
 * `unreachable` means the transient budget ran out on a socket that HAD
 * opened at least once — a mid-session drop rather than a refusal.
 */
export type WebSocketFailureReason =
  | "session-expired"
  | "handshake-refused"
  | "unreachable";

/**
 * A socket that has NEVER opened gets a much smaller budget than one that
 * dropped mid-session.
 *
 * The two failures are not alike. A mid-session drop is usually a blip and is
 * worth waiting out. A handshake that is refused on the first attempt is
 * usually refused for a structural reason — most often a session key minted by
 * a revision that no longer exists — and twenty attempts at that is twenty
 * ways of saying nothing while the customer stares at a dead chat.
 */
const HANDSHAKE_MAX_ATTEMPTS = 3;

export interface WebSocketHookOptions {
  queryParams?: Record<string, string | boolean>;
  /**
   * WebSocket subprotocols, passed straight to the `WebSocket` constructor.
   *
   * This is how a secret reaches the server WITHOUT going in the URL. A browser
   * cannot set arbitrary headers on a WS handshake, so anything the server needs
   * has historically had to ride the query string -- where ingress and access
   * logs record it in plaintext. Subprotocols become the
   * `Sec-WebSocket-Protocol` REQUEST HEADER, which those logs do not capture.
   */
  protocols?: string[];
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  /**
   * The socket was refused in a way that will be refused again. Fired INSTEAD
   * of `onError`, not alongside it: a caller that treats the two the same is
   * back to being unable to tell "wait" from "this will never work", which is
   * the bug this separation exists to prevent.
   */
  onPermanentClose?: (event: CloseEvent) => void;
  /**
   * The socket never opened, and the handshake budget is spent.
   *
   * Separate from `onPermanentClose` because the CERTAINTY differs and the
   * copy must differ with it. `onPermanentClose` means the server said 1008 —
   * we know it was a rejection. This means the upgrade was answered with an
   * HTTP status and the browser gave us 1006, which is also what an
   * unreachable server looks like. Same remedy, weaker claim.
   */
  onHandshakeRefused?: (event: CloseEvent) => void;
  reconnect?: {
    enabled?: boolean;
    /** Defaults to DEFAULT_MAX_RECONNECT_ATTEMPTS. Was previously unbounded. */
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export const useWebSocket = <T = string>(
  url: string,
  options?: WebSocketHookOptions,
) => {
  const [isConnected, setIsConnected] = React.useState(false);
  const [lastMessage, setLastMessage] = React.useState<T | null>(null);
  const [messages, setMessages] = React.useState<T[]>([]);
  const [error, setError] = React.useState<Error | null>(null);
  const [isReconnecting, setIsReconnecting] = React.useState(false);
  const [failureReason, setFailureReason] =
    React.useState<WebSocketFailureReason | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const attemptCountRef = React.useRef(0);
  const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = React.useRef(true); // Only set to false by disconnect()
  /*
   * Has this hook instance EVER reached `onopen`?
   *
   * This is the only signal that distinguishes "the server refused the
   * upgrade" from "the connection dropped", and against the server that is
   * actually deployed today it is the ONLY one that fires at all: the
   * accept-then-close path that makes 1008 reach the browser is on
   * lane/backend and in no build, so every rejection in production arrives as
   * 1006. A frontend relying solely on close codes cannot see the failure it
   * was written for until that ships.
   *
   * A ref, not state: it is read inside `onclose`, which closes over the
   * render that created the socket.
   */
  const everOpenedRef = React.useRef(false);
  /*
   * Guards `onHandshakeRefused` to the TRANSITION rather than the state.
   *
   * Without it the callback fires on every close once the budget is spent, not
   * just on the one that spends it — the give-up branch is reached again by
   * any later close event. Harmless against a boolean store, wrong for a
   * caller that logs or shows a toast, and wrong as a contract either way.
   */
  const handshakeRefusedFiredRef = React.useRef(false);
  // Track which WebSocket instances are allowed to reconnect using a WeakSet
  const allowedToReconnectRef = React.useRef<WeakSet<WebSocket>>(new WeakSet());

  // Store options in a ref to avoid reconnecting when callbacks change
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const connectWebSocket = React.useCallback(() => {
    // Build URL with query parameters if provided
    let wsUrl = url;
    if (optionsRef.current?.queryParams) {
      const stringParams = Object.entries(
        optionsRef.current.queryParams,
      ).reduce(
        (acc, [key, value]) => {
          acc[key] = String(value);
          return acc;
        },
        {} as Record<string, string>,
      );
      const params = new URLSearchParams(stringParams);
      wsUrl = `${url}?${params.toString()}`;
    }

    const protocols = optionsRef.current?.protocols;
    const ws =
      protocols && protocols.length > 0
        ? new WebSocket(wsUrl, protocols)
        : new WebSocket(wsUrl);
    wsRef.current = ws;
    // Mark this WebSocket instance as allowed to reconnect
    allowedToReconnectRef.current.add(ws);

    ws.onopen = (event) => {
      setIsConnected(true);
      setError(null); // Clear any previous errors
      setIsReconnecting(false);
      setFailureReason(null);
      everOpenedRef.current = true;
      // A later refusal is a NEW failure and must be reportable again.
      handshakeRefusedFiredRef.current = false;
      attemptCountRef.current = 0; // Reset attempt count on successful connection
      optionsRef.current?.onOpen?.(event);
    };

    ws.onmessage = (event) => {
      setLastMessage(event.data);
      setMessages((prev) => [...prev, event.data]);
      optionsRef.current?.onMessage?.(event);
    };

    ws.onclose = (event) => {
      // Check if this specific WebSocket instance is allowed to reconnect
      const canReconnect = allowedToReconnectRef.current.has(ws);
      const closure = classifyCloseCode(event.code);
      setIsConnected(false);
      // If the connection closes with an error code, treat it as an error
      if (closure !== "normal") {
        setError(new Error(describeCloseEvent(event.code, event.reason)));
        // Only report to the caller if allowed to reconnect — an unmount is
        // not a failure. A permanent rejection takes its own channel so the
        // caller can offer a reload instead of a spinner.
        if (canReconnect) {
          if (closure === "permanent") {
            optionsRef.current?.onPermanentClose?.(event);
          } else {
            optionsRef.current?.onError?.(event);
          }
        }
      }
      optionsRef.current?.onClose?.(event);

      // A permanent rejection is not retried at all, not even once. The key
      // the handshake carried is the same key the next handshake would carry,
      // and the sandbox registry that would have to recognise it is in-process
      // memory (process_sandbox_service.py `_processes`) — a container restart
      // empties it, so a key minted by an earlier revision can never validate
      // again. Retrying that is a loop with no exit.
      if (closure === "permanent") {
        setIsReconnecting(false);
        setFailureReason("session-expired");
        return;
      }

      // Attempt reconnection if enabled and allowed
      // IMPORTANT: Only reconnect if this specific instance is allowed to reconnect
      const reconnectConfig = optionsRef.current?.reconnect;
      const wantsReconnect =
        (reconnectConfig?.enabled ?? false) &&
        canReconnect &&
        shouldReconnectRef.current;
      /*
       * Two budgets, chosen by whether the socket ever opened. See
       * HANDSHAKE_MAX_ATTEMPTS — a refused handshake and a mid-session drop
       * fail for different reasons and deserve different patience.
       *
       * The caller's explicit `maxAttempts` still wins in both cases; this
       * only changes the DEFAULT, and both call sites pass `{ enabled: true }`
       * and nothing else.
       */
      const maxAttempts =
        reconnectConfig?.maxAttempts ??
        (everOpenedRef.current
          ? DEFAULT_MAX_RECONNECT_ATTEMPTS
          : HANDSHAKE_MAX_ATTEMPTS);

      if (wantsReconnect && attemptCountRef.current < maxAttempts) {
        setIsReconnecting(true);
        attemptCountRef.current += 1;

        reconnectTimeoutRef.current = setTimeout(
          () => {
            connectWebSocket();
          },
          getReconnectDelayMs(attemptCountRef.current, reconnectConfig),
        );
        return;
      }

      setIsReconnecting(false);
      if (wantsReconnect) {
        /*
         * Wanted to retry, had no attempts left. WHICH failure it was is
         * decided by whether the socket ever opened, not by the close code —
         * the code is 1006 either way once the upgrade is refused.
         *
         * `handshake-refused` deliberately does NOT claim the session expired.
         * The two causes — a dead session key and an unreachable server — are
         * indistinguishable from here, and asserting the first would tell
         * someone whose network dropped a specific untrue thing about their
         * account. The copy it drives offers the reload, which is the action
         * that helps in both cases, without naming a cause we cannot see.
         */
        if (everOpenedRef.current) {
          setFailureReason("unreachable");
        } else {
          setFailureReason("handshake-refused");
          if (!handshakeRefusedFiredRef.current) {
            handshakeRefusedFiredRef.current = true;
            optionsRef.current?.onHandshakeRefused?.(event);
          }
        }
      }
    };

    ws.onerror = (event) => {
      setIsConnected(false);
      optionsRef.current?.onError?.(event);
    };
  }, [url]);

  React.useEffect(() => {
    // Reset shouldReconnect flag and attempt count when creating a new connection
    shouldReconnectRef.current = true;
    attemptCountRef.current = 0;
    setFailureReason(null);

    // Only attempt connection if we have a valid URL
    if (url && url.trim() !== "") {
      connectWebSocket();
    }

    return () => {
      // Disable reconnection on unmount to prevent reconnection attempts
      // This must be set BEFORE closing the socket, so the onclose handler sees it
      shouldReconnectRef.current = false;
      // Clear any pending reconnection timeouts
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Close the WebSocket connection
      if (wsRef.current) {
        const { readyState } = wsRef.current;
        // Remove this WebSocket from the allowed list BEFORE closing
        // so its onclose handler won't try to reconnect
        allowedToReconnectRef.current.delete(wsRef.current);
        // Only close if not already closed/closing
        if (
          readyState === WebSocket.CONNECTING ||
          readyState === WebSocket.OPEN
        ) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, [url, connectWebSocket]);

  const sendMessage = React.useCallback(
    (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    },
    [],
  );

  const disconnect = React.useCallback(() => {
    shouldReconnectRef.current = false;
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      // Remove from allowed list before closing
      allowedToReconnectRef.current.delete(wsRef.current);
      wsRef.current.close();
    }
  }, []);

  return {
    isConnected,
    lastMessage,
    messages,
    error,
    socket: wsRef.current,
    sendMessage,
    isReconnecting,
    attemptCount: attemptCountRef.current,
    /** Non-null once the socket has stopped trying. See WebSocketFailureReason. */
    failureReason,
    isSessionExpired: failureReason === "session-expired",
    disconnect,
  };
};
