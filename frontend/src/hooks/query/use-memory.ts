import { useQuery } from "@tanstack/react-query";
import MemoryService from "#/api/memory-service/memory-service.api";

export const MEMORY_QUERY_KEY = ["user", "memory"];

export const useMemory = () =>
  useQuery({
    queryKey: MEMORY_QUERY_KEY,
    queryFn: MemoryService.get,
    // The document changes only when the customer edits it here, so there is
    // nothing to poll for and refetching on every focus would discard an
    // in-progress edit.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
