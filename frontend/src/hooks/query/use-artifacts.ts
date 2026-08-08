import { useQuery } from "@tanstack/react-query";
import ArtifactsService from "#/api/artifacts/artifacts.api";
import { useIsAuthed } from "./use-is-authed";

export const ARTIFACTS_QUERY_KEY = ["user", "artifacts"];

export const artifactQueryKey = (id: string) => [
  ...ARTIFACTS_QUERY_KEY,
  "detail",
  id,
];

/** The gallery. Summaries only — no content travels for a list of titles. */
export const useArtifacts = () => {
  const { data: userIsAuthenticated } = useIsAuthed();

  return useQuery({
    queryKey: ARTIFACTS_QUERY_KEY,
    queryFn: () => ArtifactsService.list(),
    enabled: !!userIsAuthenticated,
  });
};

export const useArtifact = (id: string | undefined) =>
  useQuery({
    queryKey: artifactQueryKey(id ?? ""),
    queryFn: () => ArtifactsService.get(id!),
    enabled: !!id,
  });
