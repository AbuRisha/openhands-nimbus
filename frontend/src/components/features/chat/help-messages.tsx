import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useHelpStore } from "#/stores/help-store";
import { BUILT_IN_COMMANDS } from "#/utils/constants";

interface HelpMessagesProps {
  /** Nullable to match `ModelMessages` and the call site: `messages.tsx`
   *  derives it from route params, which are undefined before the route
   *  resolves. */
  conversationId: string | null;
  anchorEventId: string | null;
}

/**
 * The `/help` response: the built-in commands, rendered inline where the user
 * typed.
 *
 * READS `BUILT_IN_COMMANDS` DIRECTLY rather than a stored snapshot. That is the
 * whole design: adding a command to the registry makes it appear here with no
 * second edit, so help cannot document a command set the build does not have.
 * Confidently-wrong help is worse than none.
 *
 * The description comes from `skill.content`, which is the same string the
 * slash MENU shows while typing. One source, so the menu and the help text can
 * never disagree about what a command does.
 */
export function HelpMessages({
  conversationId,
  anchorEventId,
}: HelpMessagesProps) {
  const { t } = useTranslation();
  const entries = useHelpStore((s) =>
    conversationId ? (s.entriesByConversation[conversationId] ?? []) : [],
  );

  const mine = entries.filter((e) => e.anchorEventId === anchorEventId);
  if (mine.length === 0) return null;

  return (
    <>
      {mine.map((entry) => (
        <div
          key={entry.id}
          data-testid="help-entry"
          className="my-2 rounded-lg border border-[#3A3E48] bg-[#20222A] p-3 text-sm"
        >
          <p className="mb-2 text-xs uppercase tracking-wide text-[#8A8F9C]">
            {t(I18nKey.HELP$TITLE)}
          </p>

          <dl className="flex flex-col gap-1.5">
            {BUILT_IN_COMMANDS.map((item) => (
              <div key={item.command} className="flex gap-3">
                <dt className="w-20 shrink-0 font-mono text-[#C7CCD8]">
                  {item.command}
                </dt>
                <dd className="text-[#A9B0C0]">{item.skill.content}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-2 text-xs text-[#8A8F9C]">
            {t(I18nKey.HELP$FOOTER)}
          </p>
        </div>
      ))}
    </>
  );
}
