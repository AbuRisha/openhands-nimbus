import React from "react";
import {
  classifyCloseCode,
  describeCloseEvent,
  getReconnectDelayMs,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  HANDSHAKE_MAX_ATTEMPTS,
  HANDSHAKE_BASE_DELAY_MS,
} from "#/utils/websocket-close";

/**
 * Why the connection stopped, when it stopped for good.
 *
 * `session-expired` is a rejection no retry can fix — the caller has to get a
 * new session key, which in practice means reloading the page.
 * `unreachable` means the transient budget ran out.
 */
export type WebSocketFailureReason = "session-expired" | "unreachable";

export interface WebSocketHookOptions {
  queryParams?: Record<string, string | boolean>;
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
  /**
   * Did the CURRENT run of attempts ever reach `onopen`?
   *
   * The only thing that separates a refused handshake from a dropped network:
   * both arrive as 1006. See HANDSHAKE_MAX_ATTEMPTS.
   */
  const everOpenedRef = React.useRef(false);
  const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = React.useRef(true); // Only set to false by disconnect()
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

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    // Mark this WebSocket instance as allowed to reconnect
    allowedToReconnectRef.current.add(ws);

    ws.onopen = (event) => {
      setIsConnected(true);
      setError(null); // Clear any previous errors
      setIsReconnecting(false);
      setFailureReason(null);
      attemptCountRef.current = 0; // Reset attempt count on successful connection
      everOpenedRef.current = true;
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

      // A socket that never opened was REFUSED, not interrupted — and the
      // refusal cannot say so, because a handshake that never completed
      // reaches the browser as 1006. Fewer attempts, spaced further apart.
      const neverOpened = !everOpenedRef.current;
      const configuredMax =
        reconnectConfig?.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      const maxAttempts = neverOpened
        ? Math.min(configuredMax, HANDSHAKE_MAX_ATTEMPTS)
        : configuredMax;
      const delayConfig =
        neverOpened && reconnectConfig?.baseDelayMs === undefined
          ? { ...reconnectConfig, baseDelayMs: HANDSHAKE_BASE_DELAY_MS }
          : reconnectConfig;

      if (wantsReconnect && attemptCountRef.current < maxAttempts) {
        setIsReconnecting(true);
        attemptCountRef.current += 1;

        reconnectTimeoutRef.current = setTimeout(
          () => {
            connectWebSocket();
          },
          getReconnectDelayMs(attemptCountRef.current, delayConfig),
        );
        return;
      }

      setIsReconnecting(false);
      if (wantsReconnect) {
        // Wanted to retry, had no attempts left.
        if (neverOpened) {
          // Nothing here can be fixed by waiting: no route, or something in
          // front refusing the upgrade. Same terminal state as a real 1008,
          // because the only useful action is the same one — reload.
          setFailureReason("session-expired");
          optionsRef.current?.onPermanentClose?.(event);
        } else {
          setFailureReason("unreachable");
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
    everOpenedRef.current = false;
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
