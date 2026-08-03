import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

interface TermsAndPrivacyNoticeProps {
  className?: string;
}

export function TermsAndPrivacyNotice({
  className,
}: TermsAndPrivacyNoticeProps) {
  const { t } = useTranslation();

  return (
    <p
      className={cn("text-xs text-center text-muted-foreground", className)}
      data-testid="terms-and-privacy-notice"
    >
      {/*
        These MUST point at Nimbus's own documents.

        They linked to https://www.all-hands.dev/tos and /privacy — the
        upstream vendor's. A user ticking "I agree" at signup was agreeing to
        a third party's terms for a product that third party does not operate,
        which binds them to nothing here and misrepresents who they are
        contracting with. Both nimbusapi.net pages exist and return 200.
      */}
      {t(I18nKey.AUTH$BY_SIGNING_UP_YOU_AGREE_TO_OUR)}{" "}
      <a
        href="https://nimbusapi.net/terms"
        target="_blank"
        className="underline hover:text-primary"
        rel="noopener noreferrer"
      >
        {t(I18nKey.COMMON$TERMS_OF_SERVICE)}
      </a>{" "}
      {t(I18nKey.COMMON$AND)}{" "}
      <a
        href="https://nimbusapi.net/privacy"
        target="_blank"
        className="underline hover:text-primary"
        rel="noopener noreferrer"
      >
        {t(I18nKey.COMMON$PRIVACY_POLICY)}
      </a>
      .
    </p>
  );
}
