import React from "react";

/**
 * Close codes that reconnecting can NEVER fix.
 *
 * 1008 POLICY_VIOLATION is what `agent_proxy_router` sends — before accept —
 * when `session_api_key` does not resolve to a live sandbox. The sandbox store
 * (`process_sandbox_service._processes`) is a module-level in-memory dict and
 * the sandbox is a CHILD PROCESS of the app container, so a revision swap kills
 * both: every previously minted key becomes permanently unvalidatable. The
 * credential is not stale, it is dead, and no number of retries can revive it.
 *
 * Retrying anyway is what stranded every open chat tab in a silent 3-second
 * loop after a deploy — forever, because `maxAttempts` defaulted to Infinity and
 * both call sites pass only `{ enabled: true }`. The user sees a chat that never
 * reconnects and no reason why; only a reload fixes it, and nothing tells them
 * to reload.
 *
 * 1000 and 1001 are normal/going-away and are also not worth retrying — the
 * peer closed deliberately.
 */
const TERMINAL_CLOSE_CODES = new Set([1000, 1001, 1008]);

/**
 * Attempts allowed when the socket has NEVER opened.
 *
 * Deliberately small. A never-opened close is a refused handshake — a 403/401
 * the browser will not show us — and retrying an authorization decision cannot
 * change it. Three covers a server that is still starting; more is just noise
 * aimed at a door that is locked.
 */
const HANDSHAKE_MAX_ATTEMPTS = 3;

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

/** 3s, 6s, 12s, 24s, then capped at 30s. */
export const reconnectDelay = (attempt: number): number =>
  Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RECONNECT_DELAY_MS,
  );

export interface WebSocketHookOptions {
  queryParams?: Record<string, string | boolean>;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
  };
  /**
   * Called when the connection is gone for good — a terminal close code, or
   * attempts exhausted. This is the hook telling the UI to stop waiting and say
   * something, which is the part that was missing.
   */
  onUnrecoverable?: (event: CloseEvent) => void;
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
  const [isUnrecoverable, setIsUnrecoverable] = React.useState(false);
  const wsRef = React.useRef<WebSocket | null>(null);
  const attemptCountRef = React.useRef(0);
  /**
   * Did the CURRENT run of attempts ever reach `onopen`?
   *
   * The browser never exposes an HTTP rejection to JS: a handshake refused with
   * 403 (or 401) surfaces as close code 1006, which is indistinguishable by
   * CODE from a mid-session network blip. The distinguishing fact is whether we
   * were ever connected. Never-opened 1006 means the server refused the
   * upgrade, and retrying an authorization failure cannot fix it — that is what
   * produced a tab hammering /sockets/events every few seconds forever after
   * its conversation was deleted.
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
      // A successful open clears it: reconnect churn should not leave the UI
      // permanently claiming the session is dead.
      setIsUnrecoverable(false);
      setIsConnected(true);
      setError(null); // Clear any previous errors
      setIsReconnecting(false);
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
      setIsConnected(false);
      // If the connection closes with an error code, treat it as an error
      if (event.code !== 1000) {
        // 1000 is normal closure
        setError(
          new Error(
            `WebSocket closed with code ${event.code}: ${event.reason || "Connection closed unexpectedly"}`,
          ),
        );
        // Also call onError handler for error closures (only if allowed to reconnect)
        if (canReconnect) {
          optionsRef.current?.onError?.(event);
        }
      }
      optionsRef.current?.onClose?.(event);

      // Attempt reconnection if enabled and allowed
      // IMPORTANT: Only reconnect if this specific instance is allowed to reconnect
      const reconnectEnabled = optionsRef.current?.reconnect?.enabled ?? false;
      // Bounded by DEFAULT. Infinity was the old default and it is the wrong
      // one: an unbounded retry with no surfacing is indistinguishable from a
      // hung UI. 20 attempts at 3s covers a minute of ordinary restart churn.
      const configuredMax = optionsRef.current?.reconnect?.maxAttempts ?? 20;
      // A socket that NEVER opened was refused, not interrupted. Three tries
      // covers a server still coming up; beyond that we are retrying a "no",
      // and 20 attempts at an auth failure is 20 pointless requests per tab.
      const maxAttempts = everOpenedRef.current
        ? configuredMax
        : Math.min(configuredMax, HANDSHAKE_MAX_ATTEMPTS);
      const isTerminal = TERMINAL_CLOSE_CODES.has(event.code);

      if (
        reconnectEnabled &&
        canReconnect &&
        !isTerminal &&
        shouldReconnectRef.current &&
        attemptCountRef.current < maxAttempts
      ) {
        setIsReconnecting(true);
        attemptCountRef.current += 1;

        reconnectTimeoutRef.current = setTimeout(
          () => {
            connectWebSocket();
          },
          // EXPONENTIAL BACKOFF, capped. A fixed 3s delay means every stranded
          // tab hits the server at the same steady rate for as long as it is
          // open — and they all reconnect together after a deploy, so the rate
          // is multiplied by the number of open tabs exactly when the server is
          // least able to absorb it.
          reconnectDelay(attemptCountRef.current),
        );
      } else {
        setIsReconnecting(false);
        // Only when we were actually trying to hold this connection open. A
        // deliberate disconnect() is not an unrecoverable failure.
        if (reconnectEnabled && canReconnect && shouldReconnectRef.current) {
          setIsUnrecoverable(true);
          optionsRef.current?.onUnrecoverable?.(event);
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
    /**
     * True when the connection is gone for good. Callers should tell the user to
     * reload rather than continue showing a live-looking chat: after a deploy
     * the session key cannot be revived, so nothing else will fix it.
     */
    isUnrecoverable,
    attemptCount: attemptCountRef.current,
    disconnect,
  };
};
