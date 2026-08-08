import { openHands } from "#/api/open-hands-axios";

export type ArtifactKind = "markdown" | "code" | "html" | "text";

/** Gallery row. Carries NO content — see ArtifactDetail. */
export interface ArtifactSummary {
  id: string;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  created_at: string;
  updated_at: string;
  version_count: number;
}

export interface ArtifactVersionMeta {
  version: number;
  created_at: string;
  /** Set when this version exists because an older one was restored. */
  restored_from: number | null;
  conversation_id: string | null;
  size_chars: number;
}

/**
 * One artifact with its CURRENT content and its history as metadata only.
 *
 * Old content is deliberately not included: fifty versions of a long document
 * is most of an account's storage, and it is read one version at a time.
 * `getVersion` fetches the content of a specific one.
 */
export interface ArtifactDetail {
  id: string;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  created_at: string;
  updated_at: string;
  current_version: number | null;
  content: string;
  versions: ArtifactVersionMeta[];
}

export interface ArtifactVersionContent {
  version: number;
  content: string;
  created_at: string;
  restored_from: number | null;
  conversation_id: string | null;
}

export interface CreateArtifactRequest {
  title: string;
  content?: string;
  kind?: ArtifactKind;
  language?: string | null;
  conversation_id?: string | null;
}

export interface UpdateArtifactRequest {
  title?: string;
  /**
   * Sending this creates a NEW VERSION rather than editing the current one in
   * place. Checked against undefined server-side, so an empty string is a real
   * edit that clears the document rather than a no-op.
   */
  content?: string;
  kind?: ArtifactKind;
  language?: string | null;
  conversation_id?: string | null;
}

class ArtifactsService {
  static async list(): Promise<ArtifactSummary[]> {
    const { data } =
      await openHands.get<ArtifactSummary[]>("/api/v1/artifacts");
    return data;
  }

  static async get(id: string): Promise<ArtifactDetail> {
    const { data } = await openHands.get<ArtifactDetail>(
      `/api/v1/artifacts/${id}`,
    );
    return data;
  }

  static async create(request: CreateArtifactRequest): Promise<ArtifactDetail> {
    const { data } = await openHands.post<ArtifactDetail>(
      "/api/v1/artifacts",
      request,
    );
    return data;
  }

  static async update(
    id: string,
    request: UpdateArtifactRequest,
  ): Promise<ArtifactDetail> {
    const { data } = await openHands.patch<ArtifactDetail>(
      `/api/v1/artifacts/${id}`,
      request,
    );
    return data;
  }

  static async getVersion(
    id: string,
    version: number,
  ): Promise<ArtifactVersionContent> {
    const { data } = await openHands.get<ArtifactVersionContent>(
      `/api/v1/artifacts/${id}/versions/${version}`,
    );
    return data;
  }

  /**
   * Makes an older version current by APPENDING it again — nothing is deleted,
   * so restoring a restore works. A POST rather than a PUT because it is not
   * idempotent: calling it twice produces two new versions.
   */
  static async restore(id: string, version: number): Promise<ArtifactDetail> {
    const { data } = await openHands.post<ArtifactDetail>(
      `/api/v1/artifacts/${id}/restore/${version}`,
    );
    return data;
  }

  static async remove(id: string): Promise<void> {
    await openHands.delete(`/api/v1/artifacts/${id}`);
  }
}

export default ArtifactsService;
