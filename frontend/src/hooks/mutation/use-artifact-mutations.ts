import { useMutation, useQueryClient } from "@tanstack/react-query";
import ArtifactsService, {
  ArtifactDetail,
  CreateArtifactRequest,
  UpdateArtifactRequest,
} from "#/api/artifacts/artifacts.api";
import {
  ARTIFACTS_QUERY_KEY,
  artifactQueryKey,
} from "#/hooks/query/use-artifacts";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { extractErrorMessage } from "#/utils/extract-error-message";
import i18n from "#/i18n";
import { I18nKey } from "#/i18n/declaration";

/**
 * Every mutation seeds the detail cache from the RESPONSE rather than from what
 * was submitted, and every one invalidates the gallery.
 *
 * The response is authoritative in a way the request is not: content is
 * truncated to a cap server-side, and the version number, `updated_at` and the
 * history entry are all assigned there. Writing the submitted value back would
 * show a customer a version number that does not exist yet and content longer
 * than what was stored.
 */
const useSeedFromResponse = () => {
  const queryClient = useQueryClient();
  return (detail: ArtifactDetail) => {
    queryClient.setQueryData(artifactQueryKey(detail.id), detail);
    queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY_KEY });
  };
};

export const useCreateArtifact = () => {
  const seed = useSeedFromResponse();

  return useMutation({
    mutationFn: (request: CreateArtifactRequest) =>
      ArtifactsService.create(request),
    onSuccess: seed,
    onError: (error) =>
      displayErrorToast(
        extractErrorMessage(error, i18n.t(I18nKey.ARTIFACTS$SAVE_FAILED)),
      ),
  });
};

export const useUpdateArtifact = () => {
  const seed = useSeedFromResponse();

  return useMutation({
    mutationFn: ({ id, ...request }: UpdateArtifactRequest & { id: string }) =>
      ArtifactsService.update(id, request),
    onSuccess: seed,
    onError: (error) =>
      displayErrorToast(
        extractErrorMessage(error, i18n.t(I18nKey.ARTIFACTS$SAVE_FAILED)),
      ),
  });
};

export const useRestoreArtifactVersion = () => {
  const seed = useSeedFromResponse();

  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      ArtifactsService.restore(id, version),
    onSuccess: seed,
    onError: (error) =>
      displayErrorToast(
        extractErrorMessage(error, i18n.t(I18nKey.ARTIFACTS$RESTORE_FAILED)),
      ),
  });
};

export const useDeleteArtifact = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => ArtifactsService.remove(id),
    onSuccess: (_result, id) => {
      // Drop the detail entry outright. Invalidating would refetch a deleted
      // artifact and surface its 404 as an error toast on a screen the
      // customer has already left.
      queryClient.removeQueries({ queryKey: artifactQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY_KEY });
    },
    onError: (error) =>
      displayErrorToast(
        extractErrorMessage(error, i18n.t(I18nKey.ARTIFACTS$DELETE_FAILED)),
      ),
  });
};
