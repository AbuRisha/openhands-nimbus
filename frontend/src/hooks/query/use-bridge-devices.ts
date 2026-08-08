import { useQuery } from "@tanstack/react-query";
import { openHands } from "#/api/open-hands-axios";

/**
 * Which browsers this account has paired, and which are reachable right now.
 *
 * No user id is passed. That is deliberate on both sides: the endpoint derives
 * the account from the session cookie, and the browser could not supply an id
 * even if the endpoint wanted one — `useMe` is SaaS-gated and this ships oss,
 * and `/api/v1/nimbus/account` returns email and balance but no id. An earlier
 * `GET /bridge/devices/{user_id}` signature was therefore unbuildable from here
 * as well as unauthenticated.
 *
 * `connected` is the field that carries the weight. A device that is paired but
 * not connected is NOT an error and must not be offered a re-pair: the browser
 * is simply closed, and pairing again would leave two entries for one Chrome.
 * "Paired, not open" and "no browser paired" are different sentences.
 */

export interface BridgeDevice {
  device_id: string;
  name: string;
  connected: boolean;
  paired_at: string;
}

interface BridgeDevicesResponse {
  devices: BridgeDevice[];
}

export const BRIDGE_DEVICES_QUERY_KEY = "bridge-devices";

export function useBridgeDevices(enabled = true) {
  return useQuery({
    queryKey: [BRIDGE_DEVICES_QUERY_KEY],
    queryFn: async (): Promise<BridgeDevice[]> => {
      const { data } =
        await openHands.get<BridgeDevicesResponse>("/bridge/devices");
      return data.devices;
    },
    enabled,
    // The panel renders its OWN explanation for every failure it can have, so
    // the global toast would put "Request failed with status code 401" directly
    // beneath "Pairing again will not help — sign in and this page will work."
    //
    // That is worse than redundant. The whole point of the signed-out state is
    // that it tells the user the one thing that helps; a raw transport string
    // next to it reads as a leak, and it is the only line in that block which
    // tells the customer nothing. Opting out is the mechanism the query client
    // already provides for exactly this case.
    meta: { disableToast: true },
    // Connectedness changes when someone opens or closes a browser, which this
    // page cannot be told about — the socket belongs to the extension, not to
    // us. Polling is the honest mechanism; 10s is slow enough to be free and
    // fast enough that the panel is not lying for long.
    refetchInterval: 10_000,
    // A 401 here means signed out, not a transient fault. Retrying just delays
    // the redirect the app already does.
    retry: false,
  });
}
