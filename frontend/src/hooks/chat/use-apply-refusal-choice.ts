import React from "react";
import {
  FailoverChoice,
  modelToRestoreAfterTurn,
} from "#/utils/refusal-failover";

/**
 * Carry out a failover choice, and put the model back afterwards.
 *
 * The restore is the whole reason this is a hook rather than a function. A
 * retry has to outlive the click that started it: the model changes, a turn
 * runs, and only when THAT turn finishes can the original be put back. Nothing
 * about that fits in an event handler, and doing it immediately would restore
 * the model before the retry had used it.
 *
 * WHAT GOES WRONG WITHOUT THE RESTORE
 * -----------------------------------
 * Everything looks correct. The retry works, the answer arrives, the customer
 * is happy — and every turn after that silently runs on a model they did not
 * choose, until they read a bill. That is the failure this exists to prevent,
 * and it is invisible at the moment it starts.
 *
 * Switching takes a PROFILE NAME, not a model id, so the caller maps back
 * through the catalog. Getting that wrong is a silent no-op: the mutation
 * resolves, nothing switches, and the retry runs on the model that just
 * refused.
 */

interface UseApplyRefusalChoiceArgs {
  /** True while a turn is running. The restore fires on the true -> false edge. */
  isRunning: boolean;
  /** Switch the conversation's model. Takes a profile NAME. */
  switchToProfile: (profileName: string) => void;
  /** Profile name for a model id, or null when the catalog has no entry. */
  profileNameForModel: (model: string) => string | null;
  /** Re-send the request that was refused. */
  resend: (text: string) => void;
}

export function useApplyRefusalChoice({
  isRunning,
  switchToProfile,
  profileNameForModel,
  resend,
}: UseApplyRefusalChoiceArgs) {
  // The model to put back once the retry's turn ends, or null if none is due.
  const pendingRestore = React.useRef<string | null>(null);
  // Whether the retry has actually started. Without this the restore fires on
  // the SAME idle state the choice was made in — before the turn it is meant
  // to outlive has even begun.
  const retryStarted = React.useRef(false);

  React.useEffect(() => {
    if (isRunning) {
      if (pendingRestore.current) retryStarted.current = true;
      return;
    }
    if (!pendingRestore.current || !retryStarted.current) return;

    const profileName = profileNameForModel(pendingRestore.current);
    pendingRestore.current = null;
    retryStarted.current = false;
    if (profileName) switchToProfile(profileName);
  }, [isRunning, profileNameForModel, switchToProfile]);

  /**
   * Act on a choice.
   *
   * `originalText` is the request that was refused, read from the last user
   * message rather than the optimistic store — by this point that store has
   * been cleared, and reading it would resend nothing.
   */
  const apply = React.useCallback(
    (
      choice: FailoverChoice,
      originalText: string,
      originalModel: string | null | undefined,
    ) => {
      if (choice.kind !== "retry") {
        // Edit and cancel change no model, so there is nothing to restore.
        // Edit deliberately does not refill the composer here: the caller owns
        // the input, and reaching into it from this hook would fight whatever
        // the customer had already started typing.
        return;
      }

      const profileName = profileNameForModel(choice.model);
      if (!profileName) return;

      // Arm the restore BEFORE switching. If switching threw after a resend
      // had already gone out, an un-armed restore would strand the session on
      // the fallback — the exact silent outcome this feature exists to avoid.
      pendingRestore.current = modelToRestoreAfterTurn(choice, originalModel);
      retryStarted.current = false;

      switchToProfile(profileName);
      resend(originalText);
    },
    [profileNameForModel, switchToProfile, resend],
  );

  return { apply };
}
