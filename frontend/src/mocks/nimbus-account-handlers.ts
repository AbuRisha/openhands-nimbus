import { http, HttpResponse } from "msw";
import type { NimbusAccount } from "#/api/nimbus-account";

/**
 * The signed-in Nimbus account, for `dev:mock`.
 *
 * Without this the panel could not be looked at. `/api/v1/nimbus/account` was
 * unmocked, so every dev session rendered "Account details unavailable" in the
 * sidebar — which is the panel's DEGRADED state, shown permanently, in the one
 * environment anyone reviews the UI in. The component was fine; nothing was
 * answering it.
 *
 * The figures are chosen to exercise the parts that are easy to get wrong and
 * impossible to see from a unit test:
 *
 * - `spent_usd` is sub-cent. `usd()` widens to 4dp below $0.01 on purpose,
 *   because a chat turn costs fractions of a cent and rounding to 2dp renders
 *   real spend as "$0.00" — indistinguishable from not being billed at all.
 * - a cap is SET, so the remaining-budget path renders rather than the
 *   unlimited one.
 * - `configured: true` with a real balance, because `configured: false` is a
 *   distinct state meaning the server could not reach nimbusapi.net. Mocking
 *   that would just reproduce the bug this fixes.
 */
const ACCOUNT: NimbusAccount = {
  configured: true,
  email: "founder@example.com",
  balance_usd: 42.5,
  chat: {
    has_key: true,
    spend_cap_usd: 10,
    spent_usd: 0.0037,
    request_count: 12,
  },
};

let account: NimbusAccount = { ...ACCOUNT, chat: { ...ACCOUNT.chat } };

export const NIMBUS_ACCOUNT_HANDLERS = [
  http.get("/api/v1/nimbus/account", async () => HttpResponse.json(account)),

  // Returns the REFRESHED account, which is what the mutation seeds its cache
  // with — a handler returning an empty 200 here would leave the panel showing
  // the old cap and look like the save silently failed.
  http.put("/api/v1/nimbus/account/spend-cap", async ({ request }) => {
    const body = (await request.json()) as { spend_cap_usd: number | null };
    account = {
      ...account,
      chat: { ...account.chat, spend_cap_usd: body.spend_cap_usd },
    };
    return HttpResponse.json(account);
  }),
];
