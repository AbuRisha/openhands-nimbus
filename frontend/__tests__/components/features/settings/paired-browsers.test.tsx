import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";
import { renderWithProviders } from "test-utils";
import { PairedBrowsers } from "#/components/features/settings/paired-browsers";

/**
 * What is worth pinning here is not that a list renders — it is that four
 * states stay four states.
 *
 * The pressure on this component is toward one button: any time no browser
 * responds, offer "pair a browser". That is wrong in two of the four cases and
 * actively harmful in one. A device that is PAIRED BUT CLOSED needs the browser
 * opened, and pairing again just adds a second entry for the same Chrome. A
 * FAILED REQUEST is not a pairing problem at all, and offering pairing there is
 * a loop that cannot terminate — the same trap the agent-side 401 branch exists
 * to avoid.
 *
 * So each test asserts the words AND, where it matters, the ABSENCE of the
 * pairing affordance. A test that only checked for the presence of text would
 * pass on the collapsed version.
 */

const { getDevices, postCode } = vi.hoisted(() => ({
  getDevices: vi.fn(),
  postCode: vi.fn(),
}));

/**
 * The real English strings, not the key names.
 *
 * Asserting on `PAIRED_BROWSERS$PAIRED_NOT_OPEN` would pass no matter what that
 * key resolved to, which defeats the point: what is being pinned here is the
 * WORDS — that a closed browser is told to be opened rather than re-paired.
 * These are copied from src/i18n/translation.json.
 */
vi.mock("react-i18next", async () => {
  const actual = await vi.importActual("react-i18next");
  const en: Record<string, string> = {
    PAIRED_BROWSERS$TITLE: "Paired browsers",
    PAIRED_BROWSERS$DESCRIPTION:
      "Pair your own Chrome so Nimbus can read and navigate pages using the sessions you are already signed into.",
    PAIRED_BROWSERS$CHECKING: "Checking for paired browsers…",
    PAIRED_BROWSERS$NONE: "No browser is paired with this account yet.",
    PAIRED_BROWSERS$CONNECTED: "Connected",
    PAIRED_BROWSERS$PAIRED_NOT_OPEN: "Paired — open this browser to use it",
    PAIRED_BROWSERS$LOOKUP_FAILED:
      "Could not check your paired browsers. This is not a pairing problem — try again shortly, and report it if it persists.",
    PAIRED_BROWSERS$SIGNED_OUT:
      "Your session has expired, so we could not check your browsers. Pairing again will not help — sign in and this page will work.",
    PAIRED_BROWSERS$SIGN_IN_AGAIN: "Sign in again",
    PAIRED_BROWSERS$CODE_INSTRUCTION:
      "Enter this code in the Nimbus extension. It expires in {{seconds}} seconds.",
    PAIRED_BROWSERS$PAIR_A_BROWSER: "Pair a browser",
    PAIRED_BROWSERS$GENERATE_NEW_CODE: "Generate a new code",
    PAIRED_BROWSERS$GENERATING: "Generating…",
    PAIRED_BROWSERS$CODE_FAILED:
      "Could not generate a pairing code. Try again shortly — your existing pairings are unaffected.",
  };
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        const s = en[key] ?? key;
        return vars
          ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""))
          : s;
      },
      i18n: { changeLanguage: () => new Promise(() => {}) },
    }),
  };
});

vi.mock("#/api/open-hands-axios", () => ({
  openHands: {
    get: (...args: unknown[]) => getDevices(...args),
    post: (...args: unknown[]) => postCode(...args),
  },
}));

const device = (over: Partial<Record<string, unknown>> = {}) => ({
  device_id: "dev-1",
  name: "Chrome on Mac",
  connected: true,
  paired_at: "2026-08-07T00:00:00Z",
  ...over,
});

describe("PairedBrowsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDevices.mockResolvedValue({ data: { devices: [] } });
  });

  it("asks for the user id nowhere — the endpoint takes none", async () => {
    renderWithProviders(<PairedBrowsers />);

    await waitFor(() => expect(getDevices).toHaveBeenCalled());
    // The by-id signature was both unauthenticated and unbuildable: the browser
    // cannot learn its own user id. This pins the path that replaced it.
    expect(getDevices).toHaveBeenCalledWith("/bridge/devices");
  });

  it("offers pairing when nothing is paired", async () => {
    renderWithProviders(<PairedBrowsers />);

    expect(await screen.findByTestId("no-browsers-paired")).toBeInTheDocument();
    expect(screen.getByTestId("pair-browser-button")).toBeInTheDocument();
  });

  it("tells the user to OPEN a paired-but-closed browser, not to re-pair it", async () => {
    getDevices.mockResolvedValue({
      data: { devices: [device({ connected: false })] },
    });

    renderWithProviders(<PairedBrowsers />);

    expect(await screen.findByText(/open this browser/i)).toBeInTheDocument();
    // The pairing is intact. Nothing here may suggest it is not.
    expect(screen.queryByTestId("no-browsers-paired")).not.toBeInTheDocument();
    expect(screen.queryByText(/no browser is paired/i)).not.toBeInTheDocument();
  });

  it("shows a connected browser as connected", async () => {
    getDevices.mockResolvedValue({ data: { devices: [device()] } });

    renderWithProviders(<PairedBrowsers />);

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Chrome on Mac")).toBeInTheDocument();
  });

  it("does not offer pairing as the remedy for a failed lookup", async () => {
    getDevices.mockRejectedValue(new Error("boom"));

    renderWithProviders(<PairedBrowsers />);

    const error = await screen.findByTestId("paired-browsers-error");
    // The words must say it is NOT a pairing problem, because the reflex is to
    // read any failure as "pair again" and that never terminates.
    expect(error).toHaveTextContent(/not a pairing problem/i);
    expect(screen.queryByTestId("no-browsers-paired")).not.toBeInTheDocument();
  });

  it("routes a 401 to SIGN IN, and hides the pairing button entirely", async () => {
    // The distinction the agent-side _explain already draws, on screen. A 401
    // is not a pairing problem: re-pairing produces no session cookie, so the
    // next request 401s too. Offering "pair" here is a loop with no exit.
    const unauthorized = new AxiosError("no", "401", undefined, null, {
      status: 401,
      data: {},
      statusText: "Unauthorized",
      headers: {},
      config: { headers: {} },
    } as never);
    getDevices.mockRejectedValue(unauthorized);

    renderWithProviders(<PairedBrowsers />);

    expect(
      await screen.findByTestId("paired-browsers-signed-out"),
    ).toHaveTextContent(/pairing again will not help/i);
    expect(screen.getByTestId("sign-in-again-button")).toBeInTheDocument();

    // Hidden, not merely disabled — a greyed-out button still reads as the
    // thing to do once you fix something else.
    expect(screen.queryByTestId("pair-browser-button")).not.toBeVisible();
    // And the generic fault message must not double up with it.
    expect(
      screen.queryByTestId("paired-browsers-error"),
    ).not.toBeInTheDocument();
  });

  it("keeps a NON-401 failure distinct from being signed out", async () => {
    getDevices.mockRejectedValue(new Error("network"));

    renderWithProviders(<PairedBrowsers />);

    expect(
      await screen.findByTestId("paired-browsers-error"),
    ).toBeInTheDocument();
    // A transient fault is not a sign-in problem, and must not send the user
    // off to re-authenticate for nothing.
    expect(
      screen.queryByTestId("paired-browsers-signed-out"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pair-browser-button")).toBeVisible();
  });

  it("shows the code and its expiry only after the user asks", async () => {
    const user = userEvent.setup();
    postCode.mockResolvedValue({
      data: { code: "H7K2M9QR", expires_in_seconds: 120 },
    });

    renderWithProviders(<PairedBrowsers />);

    // Not fetched on mount: minting REPLACES any live code, so it has to be an
    // action rather than something a query can refire on window focus.
    expect(screen.queryByTestId("pairing-code")).not.toBeInTheDocument();
    expect(postCode).not.toHaveBeenCalled();

    await user.click(await screen.findByTestId("pair-browser-button"));

    expect(await screen.findByTestId("pairing-code")).toHaveTextContent(
      "H7K2M9QR",
    );
    expect(screen.getByTestId("pairing-code")).toHaveTextContent(/120/);
  });

  it("says a second press REPLACES the code rather than adding one", async () => {
    const user = userEvent.setup();
    postCode.mockResolvedValue({
      data: { code: "H7K2M9QR", expires_in_seconds: 120 },
    });

    renderWithProviders(<PairedBrowsers />);
    await user.click(await screen.findByTestId("pair-browser-button"));
    await screen.findByTestId("pairing-code");

    // One live code per account, so "Generate a new code" is the honest label —
    // "Pair another browser" would imply the first code still works.
    expect(screen.getByTestId("pair-browser-button")).toHaveTextContent(
      /generate a new code/i,
    );
  });
});
