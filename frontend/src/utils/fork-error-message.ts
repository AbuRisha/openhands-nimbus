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
 * UNUSED, AND MUST STAY UNUSED UNTIL THE SERVER SIGNAL IS FIXED. Kept as the
 * shape the check should take, not as a check that currently works.
 *
 * The premise below was wrong. `halves_agree` compares the agent's event count
 * against the transcript's, and those two stores hold different event KINDS —
 * so a healthy full fork reports 11 against 5. The first real end-to-end fork
 * showed this warning on every success, including forks that worked exactly as
 * designed, which is why `use-fork-conversation.ts` stopped calling it.
 *
 * The original reasoning is preserved because it is still right about the
 * SITUATION and only wrong about the SIGNAL: a 200 that describes a broken
 * outcome does need its own check, since nothing in the error path fires for it.
 *
 * ORIGINAL, for the record: "`halves_agree: false` is a SUCCESS response
 * describing a broken outcome. The request returned 200 and a conversation
 * exists, so nothing in the error path fires — which is precisely why it needs
 * its own check. The agent's memory and the visible transcript were cut at
 * different points, so the two disagree about what happened."
 *
 * What would make it real: the server resolving the cutoff in BOTH id spaces
 * and reporting whether it was found on each side. "The cutoff id matched no
 * agent event" is the failure that silently copies full memory against a
 * truncated transcript — the one this was reaching for.
 */
export const shouldWarnAboutHalves = (response: {
  halves_agree: boolean;
}): boolean => !response.halves_agree;
