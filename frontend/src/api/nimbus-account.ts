import { openHands } from "./open-hands-axios";

/**
 * The signed-in Nimbus account, as chat sees it.
 *
 * `configured` false is a DISTINCT state from a zero balance: it means the
 * server could not reach nimbusapi.net or has no shared secret. Rendering that
 * as "$0.00" would tell someone with money that they have none, so the UI must
 * keep the two apart.
 */
export interface NimbusChatSpend {
  has_key: boolean;
  spend_cap_usd: number | null;
  spent_usd: number;
  request_count: number;
}

export interface NimbusAccount {
  configured: boolean;
  email: string | null;
  balance_usd: number | null;
  chat: NimbusChatSpend;
}

export const nimbusAccountApi = {
  async get(): Promise<NimbusAccount> {
    const { data } = await openHands.get<NimbusAccount>(
      "/api/v1/nimbus/account",
    );
    return data;
  },

  /** `null` clears the cap; the account balance is then the only limit. */
  async setSpendCap(spendCapUsd: number | null): Promise<NimbusAccount> {
    const { data } = await openHands.put<NimbusAccount>(
      "/api/v1/nimbus/account/spend-cap",
      { spend_cap_usd: spendCapUsd },
    );
    return data;
  },
};
