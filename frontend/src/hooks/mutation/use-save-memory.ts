import { useMutation, useQueryClient } from "@tanstack/react-query";
import MemoryService from "#/api/memory-service/memory-service.api";
import { MEMORY_QUERY_KEY } from "#/hooks/query/use-memory";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { extractErrorMessage } from "#/utils/extract-error-message";
import i18n from "#/i18n";
import { I18nKey } from "#/i18n/declaration";

export const useSaveMemory = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (text: string) => MemoryService.save(text),

    /*
     * Seed the cache with WHAT THE SERVER STORED, not with what was submitted.
     *
     * The server truncates to the cap and returns the result. Writing the
     * submitted value here — or merely invalidating and letting a refetch race
     * the editor — would leave the customer looking at text longer than what
     * is actually in their memory file, believing all of it reaches the agent.
     */
    onSuccess: (stored) => {
      queryClient.setQueryData(MEMORY_QUERY_KEY, stored);
    },

    onError: (error) => {
      displayErrorToast(
        extractErrorMessage(error, i18n.t(I18nKey.MEMORY$SAVE_FAILED)),
      );
    },
  });
};
