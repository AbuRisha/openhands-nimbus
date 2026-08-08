import { useMutation } from "@tanstack/react-query";
import { openHands } from "#/api/open-hands-axios";

/**
 * Mint a pairing code for the signed-in account.
 *
 * The code is the credential the extension redeems, and it is only meaningful
 * because it was minted inside an authenticated session — which is what lets
 * the redeem endpoint itself be public. A browser extension is a different
 * origin with different storage and cannot carry the app session, so pairing
 * has to hand something across that boundary.
 *
 * Not a query. Calling this REPLACES any outstanding code for the account (one
 * live code per user, so nobody can read a stale one off an old screen), which
 * makes it an action a person takes, not something a component may re-fetch on
 * a whim. React Query would happily refire a query on window focus and silently
 * invalidate the code the user is halfway through typing.
 */

export interface PairingCode {
  code: string;
  expires_in_seconds: number;
}

export function useCreatePairingCode() {
  return useMutation({
    mutationFn: async (): Promise<PairingCode> => {
      const { data } = await openHands.post<PairingCode>("/bridge/pair/code");
      return data;
    },
  });
}
