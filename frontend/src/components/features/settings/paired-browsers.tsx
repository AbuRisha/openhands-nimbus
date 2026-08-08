import React from "react";
import { AxiosError } from "axios";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useBridgeDevices } from "#/hooks/query/use-bridge-devices";
import { useCreatePairingCode } from "#/hooks/mutation/use-create-pairing-code";

/**
 * Paired browsers — the settings surface for the local-Chrome bridge.
 *
 * ── The distinction this component exists to preserve ───────────────────────
 * The states here are NOT degrees of the same failure, and the natural instinct
 * is to collapse them into one "pair a browser" button:
 *
 *   no devices          -> pair one. The only state where pairing is the answer.
 *   paired, connected   -> nothing to do.
 *   paired, NOT open    -> open that browser. Pairing again adds a second entry
 *                          for the same Chrome and does not connect either.
 *   request failed      -> a fault. Offering "pair" here sends the user round a
 *                          loop that cannot terminate, because pairing is not
 *                          what is broken.
 *   401, signed out     -> sign in. Re-pairing produces no session cookie, so
 *                          the next request 401s too.
 *
 * The agent side draws the same line: bridge_router answers 409 for
 * paired-but-closed, 404 for nothing-paired, 401 for could-not-authenticate,
 * and nimbus_browser_tools turns each into different words. This is that
 * distinction on screen rather than in a tool result.
 */

/**
 * A 401 is a SIGN-IN problem and must never be offered pairing as the remedy.
 *
 * Worse here than on the agent side, because the pairing button is right there:
 * re-pairing does not produce a session cookie, so the next request 401s too and
 * the user is in a loop with no exit. The only way out is signing in again.
 */
function isUnauthorized(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 401;
}

export function PairedBrowsers() {
  const { t } = useTranslation();
  const { data: devices, isLoading, isError, error } = useBridgeDevices();
  const createCode = useCreatePairingCode();

  const code = createCode.data;
  // Either request going 401 means the same thing — the session is gone — and
  // it outranks everything else on screen, including the pairing button, which
  // would otherwise invite the loop described above.
  const signedOut = isUnauthorized(error) || isUnauthorized(createCode.error);

  return (
    <section className="flex flex-col gap-4" data-testid="paired-browsers">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium text-white">
          {t(I18nKey.PAIRED_BROWSERS$TITLE)}
        </h3>
        <p className="text-sm text-[#A3A3A3]">
          {t(I18nKey.PAIRED_BROWSERS$DESCRIPTION)}
        </p>
      </div>

      {isLoading && !signedOut && (
        <p className="text-sm text-[#A3A3A3]">
          {t(I18nKey.PAIRED_BROWSERS$CHECKING)}
        </p>
      )}

      {/* Signed out. The ONE remedy is signing in, and reloading is how: the
          auth gate redirects a signed-out page load to SSO. Everything else on
          this panel is suppressed while this is true, because a pairing button
          next to this message is an invitation into a loop. */}
      {signedOut && (
        <div
          className="flex flex-col gap-2"
          data-testid="paired-browsers-signed-out"
        >
          <p className="text-sm text-red-400">
            {t(I18nKey.PAIRED_BROWSERS$SIGNED_OUT)}
          </p>
          <div>
            <BrandButton
              type="button"
              variant="secondary"
              testId="sign-in-again-button"
              onClick={() => window.location.reload()}
            >
              {t(I18nKey.PAIRED_BROWSERS$SIGN_IN_AGAIN)}
            </BrandButton>
          </div>
        </div>
      )}

      {/* A fault, stated as one. Deliberately no pairing button: pairing is not
          what failed, and offering it would suggest the user can fix this by
          repeating themselves. */}
      {isError && !signedOut && (
        <p className="text-sm text-red-400" data-testid="paired-browsers-error">
          {t(I18nKey.PAIRED_BROWSERS$LOOKUP_FAILED)}
        </p>
      )}

      {!isLoading && !isError && devices?.length === 0 && (
        <p className="text-sm text-[#A3A3A3]" data-testid="no-browsers-paired">
          {t(I18nKey.PAIRED_BROWSERS$NONE)}
        </p>
      )}

      {!!devices?.length && (
        <ul className="flex flex-col gap-2" data-testid="paired-browser-list">
          {devices.map((device) => (
            <li
              key={device.device_id}
              className="flex items-center justify-between rounded-md bg-[#0D0F11] px-3 py-2"
            >
              <span className="text-sm text-white">{device.name}</span>
              {device.connected ? (
                <span className="text-xs text-green-400">
                  {t(I18nKey.PAIRED_BROWSERS$CONNECTED)}
                </span>
              ) : (
                // NOT an error, and NOT an invitation to re-pair. The browser
                // is closed; the pairing is intact and will still be there.
                <span className="text-xs text-[#A3A3A3]">
                  {t(I18nKey.PAIRED_BROWSERS$PAIRED_NOT_OPEN)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {code ? (
        <div
          className="flex flex-col gap-2 rounded-md bg-[#0D0F11] p-4"
          data-testid="pairing-code"
        >
          <p className="text-sm text-[#A3A3A3]">
            {/* Seconds, not prose. "2 minutes" would need plural rules in
                fifteen locales to express what one number already says. */}
            {t(I18nKey.PAIRED_BROWSERS$CODE_INSTRUCTION, {
              seconds: code.expires_in_seconds,
            })}
          </p>
          {/* Wide tracking and a mono face because this gets read off a screen
              and typed into another window. The alphabet already excludes
              0/1/O/I/L for the same reason. */}
          <code className="font-mono text-2xl tracking-[0.3em] text-white">
            {code.code}
          </code>
        </div>
      ) : null}

      {/* Hidden, not disabled, while signed out. A greyed-out "Pair a browser"
          still reads as the thing to do once you fix something, and the thing
          to do here is sign in. */}
      <div hidden={signedOut}>
        <BrandButton
          type="button"
          variant="secondary"
          testId="pair-browser-button"
          isDisabled={createCode.isPending}
          onClick={() => createCode.mutate()}
        >
          {createCode.isPending
            ? t(I18nKey.PAIRED_BROWSERS$GENERATING)
            : /* Wording changes because a second press REPLACES the live code —
                 there is one per account on purpose, so a stale code on an old
                 screen cannot still work. */
              t(
                code
                  ? I18nKey.PAIRED_BROWSERS$GENERATE_NEW_CODE
                  : I18nKey.PAIRED_BROWSERS$PAIR_A_BROWSER,
              )}
        </BrandButton>
      </div>

      {createCode.isError && !signedOut && (
        <p className="text-sm text-red-400" data-testid="pairing-code-error">
          {t(I18nKey.PAIRED_BROWSERS$CODE_FAILED)}
        </p>
      )}
    </section>
  );
}

export default PairedBrowsers;
