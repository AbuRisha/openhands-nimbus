import { I18nKey } from "#/i18n/declaration";

/**
 * Which message a failed retry-from-here should show.
 *
 * THE STATUSES MEAN DIFFERENT THINGS AND MUST NOT COLLAPSE. The endpoint
 * distinguishes them deliberately, and flattening them into "something went
 * wrong" throws away the only actionable part:
 *
 *   404 — the conversation or its sandbox is gone. Nothing to retry from.
 *   409 — the sandbox is not RUNNING. The parent has to be STARTED, because the
 *         fork reads its state; "try again" is wrong advice and loops.
 *   502 — the target STARTED but could not be populated. This is the dangerous
 *         one: a conversation now EXISTS and is incomplete, so the user must be
 *         told not to trust it rather than told to retry.
 */
export const forkErrorKey = (status: number | undefined): I18nKey => {
  switch (status) {
    case 404:
      return I18nKey.FORK$ERROR_NOT_FOUND;
    case 409:
      return I18nKey.FORK$ERROR_SANDBOX_NOT_RUNNING;
    case 502:
      return I18nKey.FORK$ERROR_PARTIAL;
    default:
      return I18nKey.FORK$ERROR_GENERIC;
  }
};

/**
 * `halves_agree: false` is a SUCCESS response describing a broken outcome.
 *
 * The request returned 200 and a conversation exists, so nothing in the error
 * path fires — which is precisely why it needs its own check. The agent's memory
 * and the visible transcript were cut at different points, so the two disagree
 * about what happened.
 */
export const shouldWarnAboutHalves = (response: {
  halves_agree: boolean;
}): boolean => !response.halves_agree;
