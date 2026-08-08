"""Artifacts: a document the customer keeps, with the versions it went through.

WHAT AN ARTIFACT IS HERE, AND WHY IT IS NOT A SANDBOX FILE
----------------------------------------------------------
The obvious implementation is "a file the agent wrote in the workspace". It is
the wrong one, for a reason that only shows up later: sandbox filesystems do
not outlive the sandbox. `process_sandbox_service` keeps sandboxes in a
module-level dict of CHILD PROCESSES, so a revision swap takes them with it —
the same lifetime that makes every minted session key unvalidatable after a
deploy. An artifact gallery built on that would quietly empty itself on the
next release, and the customer would have no way to tell a deploy from data
loss.

So an artifact is stored app-server side, per customer, and its lifetime is the
account's rather than any sandbox's.

WHY VERSIONS ARE THE FEATURE, NOT A NICE-TO-HAVE
------------------------------------------------
A gallery of current documents is a file list, and the customer already has
one. What they cannot get anywhere else is "what did this look like before the
agent rewrote it, and put that back" — the agent edits confidently and
sometimes destructively, and without history a bad rewrite is unrecoverable.
Restore is therefore a first-class operation and not a stretch goal.

Every version is retained up to a cap, and RESTORE DOES NOT DELETE ANYTHING: it
appends the old content as a NEW version. Rolling back is itself an edit, so
rolling back a rollback has to work. Truncating history on restore would make
the second undo impossible, which is exactly when someone needs it.

WHAT IS NOT DECIDED HERE
------------------------
Sharing, auto-publish and print-to-PDF are listed for this item and are NOT
modelled yet, deliberately. Sharing means deciding what an unauthenticated
reader may see and how a link is revoked, which is the same class of question
as the /mcp identity finding on this codebase — and answering it badly leaks a
customer's documents. Storage and history do not depend on that answer, so they
land first and the sharing model is decided on its own terms rather than
implied by a field added early.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field

# Generous, because the point of an artifact is that it is the long thing you
# did not want in the transcript. Still bounded: this is per-version and the
# whole history is read into memory to serve one artifact.
MAX_CONTENT_CHARS = 400_000

# History is what makes restore possible, so the cap is high enough that an
# ordinary editing session never reaches it.
MAX_VERSIONS_PER_ARTIFACT = 50

MAX_ARTIFACTS_PER_USER = 200


class ArtifactKind(str, Enum):
    """How a client should render it.

    Kept deliberately coarse. The temptation is a long list mirroring every
    language, but the only decision this drives is which viewer to open, and a
    viewer that says "text" is not wrong for an unrecognised language whereas a
    missing enum member is a 500.
    """

    MARKDOWN = 'markdown'
    CODE = 'code'
    HTML = 'html'
    TEXT = 'text'


class ArtifactVersion(BaseModel):
    """One saved state of an artifact.

    `content` is stored in full rather than as a diff against the previous
    version. Diffs would be smaller and would make every read a reconstruction
    that can fail — and the failure mode of a corrupt chain is losing ALL
    history, not one version. Full copies are the boring choice and the
    recoverable one.
    """

    version: int = Field(ge=1)
    content: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # Set when this version exists because someone restored an older one, and
    # carries WHICH version it came from. Without it, a restore is
    # indistinguishable in the history from an ordinary edit that happened to
    # reproduce old content.
    restored_from: int | None = None

    # The conversation that produced this version, when one did. Optional
    # because an artifact can also be edited directly by the customer, and
    # inventing a conversation id for that would be a lie the UI would show.
    conversation_id: str | None = None


class Artifact(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    title: str = Field(min_length=1, max_length=200)
    kind: ArtifactKind = ArtifactKind.TEXT

    # Free-form, e.g. "python" or "typescript", and only a rendering hint.
    # Not validated against a list: an unknown value degrades to plain
    # highlighting, whereas a whitelist turns a new language into an error.
    language: str | None = Field(default=None, max_length=40)

    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    versions: list[ArtifactVersion] = Field(default_factory=list)

    @property
    def current(self) -> ArtifactVersion | None:
        """The newest version, or None for an artifact with no content yet.

        Returns the LAST element rather than max(version): the list is append
        -only and ordered, and if those two ever disagree the list order is the
        one that history reads by.
        """
        return self.versions[-1] if self.versions else None

    @property
    def version_count(self) -> int:
        return len(self.versions)

    def add_version(
        self,
        content: str,
        *,
        conversation_id: str | None = None,
        restored_from: int | None = None,
    ) -> ArtifactVersion:
        """Append a version and trim the OLDEST when over the cap.

        Trimming from the front means version NUMBERS are not indices — after
        a trim, `versions[0].version` is not 1. Callers must look versions up
        by their `version` field. Renumbering instead would be worse: a
        customer's "restore v3" would silently start meaning a different state.
        """
        content = content[:MAX_CONTENT_CHARS]
        next_number = (self.versions[-1].version + 1) if self.versions else 1

        version = ArtifactVersion(
            version=next_number,
            content=content,
            conversation_id=conversation_id,
            restored_from=restored_from,
        )
        self.versions.append(version)

        if len(self.versions) > MAX_VERSIONS_PER_ARTIFACT:
            self.versions = self.versions[-MAX_VERSIONS_PER_ARTIFACT:]

        self.updated_at = version.created_at
        return version

    def find_version(self, version: int) -> ArtifactVersion | None:
        return next((v for v in self.versions if v.version == version), None)

    def restore(self, version: int) -> ArtifactVersion | None:
        """Make an older version current by APPENDING it again.

        Returns None if that version is gone — trimmed, or never existed. The
        caller must treat that as a 404 rather than restoring something
        adjacent: "restore v3" resolving to v4 is worse than failing, because
        it looks like it worked.
        """
        source = self.find_version(version)
        if source is None:
            return None
        return self.add_version(source.content, restored_from=version)


class ArtifactSummary(BaseModel):
    """An artifact WITHOUT its content, for the gallery.

    The gallery lists documents that can be 400k characters each; sending
    content for all of them to render a list of titles would be the whole
    library on every page load. The detail endpoint serves content.
    """

    id: str
    title: str
    kind: ArtifactKind
    language: str | None
    created_at: datetime
    updated_at: datetime
    version_count: int

    @classmethod
    def of(cls, artifact: Artifact) -> 'ArtifactSummary':
        return cls(
            id=artifact.id,
            title=artifact.title,
            kind=artifact.kind,
            language=artifact.language,
            created_at=artifact.created_at,
            updated_at=artifact.updated_at,
            version_count=artifact.version_count,
        )
