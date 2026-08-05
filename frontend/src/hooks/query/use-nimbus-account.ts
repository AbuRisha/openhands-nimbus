import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nimbusAccountApi } from "#/api/nimbus-account";

export const NIMBUS_ACCOUNT_QUERY_KEY = ["nimbus", "account"];

/**
 * Balance and chat spend.
 *
 * Short staleTime on purpose: the point of the spend figure is that it moves
 * when a turn is billed. A long cache would show a stale number right after the
 * customer sent a message, which reads as "billing is broken" — the opposite of
 * what this is for.
 */
export const useNimbusAccount = () =>
  useQuery({
    queryKey: NIMBUS_ACCOUNT_QUERY_KEY,
    queryFn: () => nimbusAccountApi.get(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

export const useSetNimbusSpendCap = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spendCapUsd: number | null) =>
      nimbusAccountApi.setSpendCap(spendCapUsd),
    onSuccess: (data) => {
      // The PUT returns the refreshed account, so seed the cache with it
      // rather than firing a second round-trip to learn what we were told.
      queryClient.setQueryData(NIMBUS_ACCOUNT_QUERY_KEY, data);
    },
  });
};
