import { create } from "zustand";

/**
 * Set when the event socket is refused in a way no retry can fix.
 *
 * Kept apart from `error-message-store` deliberately. That store holds
 * transient, dismissible copy; this is a terminal state with exactly one way
 * out, and the two must not be able to overwrite each other.
 */
interface SessionExpiredState {
  isSessionExpired: boolean;
}

interface SessionExpiredActions {
  markSessionExpired: () => void;
  clearSessionExpired: () => void;
}

type SessionExpiredStore = SessionExpiredState & SessionExpiredActions;

const initialState: SessionExpiredState = {
  isSessionExpired: false,
};

export const useSessionExpiredStore = create<SessionExpiredStore>((set) => ({
  ...initialState,

  markSessionExpired: () => set(() => ({ isSessionExpired: true })),

  clearSessionExpired: () => set(() => ({ isSessionExpired: false })),
}));
