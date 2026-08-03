import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useResumeConversation } from "#/hooks/mutation/use-resume-conversation";
import { displayErrorToast } from "#/utils/custom-toast-handlers";

/**
 * Shown when a conversation's sandbox is gone.
 *
 * This used to be a dead end: one line of grey text and nothing else. That
 * framed an infrastructure event as a permanent property of the conversation,
 * which is both wrong and the most damaging thing in the chat experience.
 * "Archived" is not a state anyone chose — it is derived from
 * `sandbox.status == MISSING`, and under RUNTIME=process the sandbox is a child
 * process of the app container. So every deploy, replica recycle or crash ended
 * every live conversation permanently, while the transcript sat intact in
 * Postgres the whole time.
 *
 * The server could always repair it: passing an existing conversation_id to the
 * start endpoint attaches a fresh sandbox to that conversation. The only thing
 * missing was asking.
 */
export function ArchivedBanner() {
  const { t } = useTranslation();
  const { conversationId } = useParams();
  const { mutate: resume, isPending } = useResumeConversation();

  const handleResume = () => {
    if (!conversationId) return;
    resume(conversationId, {
      onError: () => displayErrorToast(t(I18nKey.CONVERSATION$RESUME_FAILED)),
    });
  };

  return (
    <div
      data-testid="archived-banner"
      className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 rounded-lg bg-neutral-700 border border-neutral-600"
    >
      <span className="text-sm text-neutral-300">
        {t(I18nKey.CONVERSATION$ARCHIVED_READ_ONLY)}
      </span>
      {/* Without a conversationId we are not on a conversation route and have
          nothing to resume — show the message alone rather than a button that
          cannot work. */}
      {conversationId && (
        <BrandButton
          type="button"
          variant="primary"
          onClick={handleResume}
          isDisabled={isPending}
          testId="resume-conversation-button"
        >
          {isPending
            ? t(I18nKey.CONVERSATION$RESUMING)
            : t(I18nKey.CONVERSATION$RESUME)}
        </BrandButton>
      )}
    </div>
  );
}
