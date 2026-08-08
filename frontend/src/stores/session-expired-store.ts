import { create } from "zustand";

/**
 * Set when the event socket is refused in a way no retry can fix.
 *
 * Kept apart from `error-message-store` deliberately. That store holds
 * transient, dismissible copy; this is a terminal state with exactly one way
 * out, and the two must not be able to overwrite each other.
 */
/**
 * How sure we are about WHY, which decides what the banner may claim.
 *
 * `rejected` — the server accepted the socket and then closed it with a
 * permanent code. It told us it was a rejection, so the copy can say so.
 *
 * `refused` — the upgrade never completed. The browser reports 1006, which is
 * identical to an unreachable server, so the copy must not name a cause. The
 * remedy is the same; the certainty is not.
 */
export type SessionEndReason = "rejected" | "refused";

interface SessionExpiredState {
  isSessionExpired: boolean;
  reason: SessionEndReason | null;
}

interface SessionExpiredActions {
  markSessionExpired: (reason?: SessionEndReason) => void;
  clearSessionExpired: () => void;
}

type SessionExpiredStore = SessionExpiredState & SessionExpiredActions;

const initialState: SessionExpiredState = {
  isSessionExpired: false,
  reason: null,
};

export const useSessionExpiredStore = create<SessionExpiredStore>((set) => ({
  ...initialState,

  // Defaults to `rejected` so the existing call sites keep their exact
  // meaning; only the new, less certain path passes "refused".
  markSessionExpired: (reason: SessionEndReason = "rejected") =>
    set(() => ({ isSessionExpired: true, reason })),

  clearSessionExpired: () =>
    set(() => ({ isSessionExpired: false, reason: null })),
}));
