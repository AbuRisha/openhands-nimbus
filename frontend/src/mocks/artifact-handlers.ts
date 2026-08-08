import { http, HttpResponse } from "msw";

/**
 * Artifacts, with a real in-memory store rather than canned responses.
 *
 * Canned responses would make the gallery LOOK right and prove nothing: the
 * whole feature is that an edit appends a version and a restore appends
 * another, so a mock that returns the same fixture for every request cannot
 * exercise the one behaviour worth testing by hand. This mirrors the server's
 * semantics — append on edit, append on restore, never truncate.
 *
 * Paths are absolute and start at "/api", which is how the real routes are
 * mounted. A relative path here would match under setupWorker and silently
 * miss under setupServer.
 */

interface MockVersion {
  version: number;
  content: string;
  created_at: string;
  restored_from: number | null;
  conversation_id: string | null;
}

interface MockArtifact {
  id: string;
  title: string;
  kind: string;
  language: string | null;
  created_at: string;
  updated_at: string;
  versions: MockVersion[];
}

const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 7, 8, 12, 0) - minutesAgo * 60_000).toISOString();

const version = (
  n: number,
  content: string,
  minutesAgo: number,
  restoredFrom: number | null = null,
): MockVersion => ({
  version: n,
  content,
  created_at: at(minutesAgo),
  restored_from: restoredFrom,
  conversation_id: null,
});

const ARTIFACTS: MockArtifact[] = [
  {
    id: "art-deploy-runbook",
    title: "Deploy runbook",
    kind: "markdown",
    language: null,
    created_at: at(120),
    updated_at: at(5),
    versions: [
      version(1, "# Deploy\n\n1. Merge to main.\n", 120),
      version(2, "# Deploy\n\n1. Merge to main.\n2. Watch the webhook.\n", 60),
      // A restore in the fixture, so the "restored from v1" label has
      // something to render without anyone having to produce it by hand.
      version(3, "# Deploy\n\n1. Merge to main.\n", 5, 1),
    ],
  },
  {
    id: "art-pricing-notes",
    title: "Pricing notes",
    kind: "text",
    language: null,
    created_at: at(400),
    updated_at: at(400),
    versions: [
      version(1, "Margin holds above 40% at current token costs.", 400),
    ],
  },
];

const summary = (a: MockArtifact) => ({
  id: a.id,
  title: a.title,
  kind: a.kind,
  language: a.language,
  created_at: a.created_at,
  updated_at: a.updated_at,
  version_count: a.versions.length,
});

const detail = (a: MockArtifact) => {
  const current = a.versions[a.versions.length - 1];
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    language: a.language,
    created_at: a.created_at,
    updated_at: a.updated_at,
    current_version: current ? current.version : null,
    content: current ? current.content : "",
    versions: a.versions.map((v) => ({
      version: v.version,
      created_at: v.created_at,
      restored_from: v.restored_from,
      conversation_id: v.conversation_id,
      size_chars: v.content.length,
    })),
  };
};

const find = (id: string | readonly string[] | undefined) =>
  ARTIFACTS.find((a) => a.id === String(id));

/**
 * Append a version, returning a NEW artifact rather than mutating the one
 * passed in.
 *
 * The store is deliberately mutable — that is what makes the mock exercise
 * append-on-edit — but the mutation happens in one place, on the ARTIFACTS
 * array, instead of through whatever reference a handler happens to hold.
 * Reassigning a caller's object is how a mock ends up with two copies of an
 * artifact that disagree about its version count.
 */
const withNewVersion = (
  a: MockArtifact,
  content: string,
  restoredFrom: number | null = null,
): MockArtifact => {
  const next = a.versions.length
    ? a.versions[a.versions.length - 1].version + 1
    : 1;
  const created = new Date().toISOString();

  return {
    ...a,
    updated_at: created,
    versions: [
      ...a.versions,
      {
        version: next,
        content,
        created_at: created,
        restored_from: restoredFrom,
        conversation_id: null,
      },
    ],
  };
};

/** Replace an artifact in the store by id, and return the stored value. */
const commit = (updated: MockArtifact): MockArtifact => {
  const index = ARTIFACTS.findIndex((a) => a.id === updated.id);
  if (index === -1) ARTIFACTS.push(updated);
  else ARTIFACTS[index] = updated;
  return updated;
};

export const ARTIFACT_HANDLERS = [
  http.get("/api/v1/artifacts", async () =>
    HttpResponse.json(
      [...ARTIFACTS]
        .sort((x, y) => y.updated_at.localeCompare(x.updated_at))
        .map(summary),
    ),
  ),

  // Declared BEFORE "/:artifactId" so the literal path wins — MSW matches in
  // registration order, and below the wildcard this would resolve as an
  // artifact whose id is "meta".
  http.get("/api/v1/artifacts/meta/limits", async () =>
    HttpResponse.json({ max_content_chars: 400000 }),
  ),

  http.get("/api/v1/artifacts/:artifactId", async ({ params }) => {
    const found = find(params.artifactId);
    if (!found) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(detail(found));
  }),

  http.get(
    "/api/v1/artifacts/:artifactId/versions/:version",
    async ({ params }) => {
      const found = find(params.artifactId);
      const v = found?.versions.find(
        (candidate) => candidate.version === Number(params.version),
      );
      if (!v) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(v);
    },
  ),

  http.post("/api/v1/artifacts", async ({ request }) => {
    const body = (await request.json()) as {
      title: string;
      content?: string;
      kind?: string;
      language?: string | null;
    };
    const created: MockArtifact = {
      id: `art-${ARTIFACTS.length + 1}`,
      title: body.title,
      kind: body.kind ?? "text",
      language: body.language ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      versions: [],
    };
    const stored = commit(withNewVersion(created, body.content ?? ""));
    return HttpResponse.json(detail(stored), { status: 201 });
  }),

  http.patch("/api/v1/artifacts/:artifactId", async ({ params, request }) => {
    const found = find(params.artifactId);
    if (!found) return new HttpResponse(null, { status: 404 });

    const body = (await request.json()) as {
      title?: string;
      content?: string;
    };
    let next =
      body.title !== undefined ? { ...found, title: body.title } : found;
    // Against undefined, not falsiness: clearing an artifact is a real edit.
    if (body.content !== undefined) next = withNewVersion(next, body.content);

    return HttpResponse.json(detail(commit(next)));
  }),

  http.post(
    "/api/v1/artifacts/:artifactId/restore/:version",
    async ({ params }) => {
      const found = find(params.artifactId);
      const source = found?.versions.find(
        (candidate) => candidate.version === Number(params.version),
      );
      if (!found || !source) return new HttpResponse(null, { status: 404 });

      // Appends rather than truncating, so restoring a restore works here too.
      const stored = commit(
        withNewVersion(found, source.content, source.version),
      );
      return HttpResponse.json(detail(stored));
    },
  ),

  http.delete("/api/v1/artifacts/:artifactId", async ({ params }) => {
    const index = ARTIFACTS.findIndex(
      (a) => a.id === String(params.artifactId),
    );
    if (index === -1) return new HttpResponse(null, { status: 404 });
    ARTIFACTS.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
];
