import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { SessionExpiredBanner } from "#/components/features/chat/session-expired-banner";
import { I18nKey } from "#/i18n/declaration";

describe("SessionExpiredBanner", () => {
  it("names the action rather than the close code", () => {
    render(<SessionExpiredBanner />);

    // `useTranslation` is mocked suite-wide to return the key, so this asserts
    // the key is wired — the copy itself lives in translation.json, all 15
    // locales.
    expect(
      screen.getByText(I18nKey.STATUS$SESSION_EXPIRED_RELOAD),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("session-expired-banner-reload"),
    ).toBeInTheDocument();
  });

  it("announces itself, because it appears without the user doing anything", () => {
    render(<SessionExpiredBanner />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("reloads on click", async () => {
    const onReload = vi.fn();
    const user = userEvent.setup();

    render(<SessionExpiredBanner onReload={onReload} />);
    await user.click(screen.getByTestId("session-expired-banner-reload"));

    expect(onReload).toHaveBeenCalledOnce();
  });
});
