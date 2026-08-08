import React from "react";
import { useTranslation } from "react-i18next";
import { History, Printer, RotateCcw, Trash2 } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";
import { useArtifact, useArtifacts } from "#/hooks/query/use-artifacts";
import {
  useDeleteArtifact,
  useRestoreArtifactVersion,
  useUpdateArtifact,
} from "#/hooks/mutation/use-artifact-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import { LoadingSpinner } from "#/components/shared/loading-spinner";
import { ConfirmationModal } from "#/components/shared/modals/confirmation-modal";
import { ArtifactPrintView } from "#/components/features/artifacts/artifact-print-view";
import { cn } from "#/utils/utils";

/**
 * The artifact gallery: what the customer has kept, and what it used to say.
 *
 * TWO PANES RATHER THAN A LIST THAT NAVIGATES. Artifacts are compared against
 * their own history far more often than they are read once, and a full-page
 * navigation per version turns "what changed" into a sequence of back-button
 * presses. The list stays put and the right pane swaps.
 *
 * HISTORY IS ALWAYS VISIBLE, not behind a toggle. Restore is the reason this
 * screen exists rather than a file list, and a feature reachable only from a
 * menu the customer has to know about is one most of them will never find at
 * the moment they need it — which is immediately after the agent has
 * overwritten something.
 */
function ArtifactsScreen() {
  const { t } = useTranslation();
  const { data: artifacts, isLoading } = useArtifacts();

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  const { data: detail, isLoading: isDetailLoading } = useArtifact(
    selectedId ?? undefined,
  );
  const { mutate: restore, isPending: isRestoring } =
    useRestoreArtifactVersion();
  const { mutate: remove } = useDeleteArtifact();
  const { mutate: update, isPending: isSaving } = useUpdateArtifact();

  const [draft, setDraft] = React.useState<string | null>(null);

  // Selecting a different artifact drops an unsaved draft rather than carrying
  // it across. Keeping it would show one artifact's text under another's
  // title, which is a data-loss bug that looks like a rendering bug.
  React.useEffect(() => {
    setDraft(null);
  }, [selectedId]);

  const content = draft ?? detail?.content ?? "";
  const isDirty = draft !== null && draft !== (detail?.content ?? "");

  const handleSave = () => {
    if (!detail || draft === null) return;
    update(
      { id: detail.id, content: draft },
      { onSuccess: () => setDraft(null) },
    );
  };

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center h-full"
        data-testid="artifacts-screen"
      >
        <LoadingSpinner size="large" />
      </div>
    );
  }

  const items = artifacts ?? [];

  return (
    <div className="flex h-full overflow-hidden" data-testid="artifacts-screen">
      {/* Gallery */}
      <div className="w-72 shrink-0 border-r border-[#4B505F] overflow-y-auto">
        <div className="p-4 border-b border-[#4B505F]">
          <h2 className="text-lg text-white">{t(I18nKey.ARTIFACTS$TITLE)}</h2>
          <p className="text-xs text-[#A9B0C0] mt-1">
            {t(I18nKey.ARTIFACTS$DESCRIPTION)}
          </p>
        </div>

        {items.length === 0 ? (
          <p
            className="p-4 text-sm text-[#8A8F9C]"
            data-testid="artifacts-empty"
          >
            {t(I18nKey.ARTIFACTS$EMPTY)}
          </p>
        ) : (
          <ul>
            {items.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  data-testid="artifact-row"
                  onClick={() => setSelectedId(artifact.id)}
                  className={cn(
                    "w-full text-left px-4 py-3 border-b border-[#3A3F4B] cursor-pointer",
                    selectedId === artifact.id
                      ? "bg-[#25272D]"
                      : "hover:bg-[#25272D]/60",
                  )}
                >
                  <span className="block text-sm text-white truncate">
                    {artifact.title}
                  </span>
                  <span className="block text-xs text-[#8A8F9C] mt-0.5">
                    {t(I18nKey.ARTIFACTS$VERSION_COUNT, {
                      count: artifact.version_count,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detail */}
      <div className="grow flex flex-col overflow-hidden">
        {!selectedId && (
          <div className="flex items-center justify-center h-full text-sm text-[#8A8F9C]">
            {t(I18nKey.ARTIFACTS$SELECT_ONE)}
          </div>
        )}

        {selectedId && isDetailLoading && (
          <div className="flex items-center justify-center h-full">
            <LoadingSpinner size="large" />
          </div>
        )}

        {selectedId && detail && (
          <>
            <div className="flex items-center gap-3 p-4 border-b border-[#4B505F]">
              <h3 className="text-white text-sm grow truncate">
                {detail.title}
              </h3>
              <BrandButton
                type="button"
                variant="primary"
                testId="artifact-save"
                isDisabled={!isDirty || isSaving}
                onClick={handleSave}
              >
                {t(I18nKey.ARTIFACTS$SAVE_VERSION)}
              </BrandButton>
              {/*
               * Prints WHAT IS SAVED, not the draft in the editor. An unsaved
               * edit is not a version and has no version number, so a printout
               * of it would carry a header naming a version whose content is
               * not what is on the page. The save button sits right here if
               * the draft is what they meant to print.
               */}
              <button
                type="button"
                data-testid="artifact-print"
                aria-label={t(I18nKey.ARTIFACTS$PRINT)}
                onClick={() => window.print()}
                className="button-base p-1.5 cursor-pointer"
              >
                <Printer className="w-4 h-4" />
              </button>
              <button
                type="button"
                data-testid="artifact-delete"
                aria-label={t(I18nKey.ARTIFACTS$DELETE)}
                onClick={() => setPendingDelete(detail.id)}
                className="button-base p-1.5 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {/*
             * Mounted here rather than created when the button is pressed:
             * window.print() is synchronous and captures the document as it
             * stands, so a node mounted in the same tick may not have been
             * committed. See ArtifactPrintView.
             */}
            <ArtifactPrintView
              title={detail.title}
              content={detail.content}
              kind={detail.kind}
              version={detail.current_version}
              updatedAt={detail.updated_at}
            />

            <div className="flex grow overflow-hidden">
              <textarea
                data-testid="artifact-content"
                value={content}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={detail.title}
                className="grow m-4 rounded-lg border border-[#4B505F] bg-[#25272D] p-3 text-sm text-white outline-none resize-none font-mono"
              />

              <div className="w-64 shrink-0 border-l border-[#4B505F] overflow-y-auto">
                <div className="flex items-center gap-2 p-3 border-b border-[#4B505F] text-xs text-[#A9B0C0]">
                  <History className="w-3.5 h-3.5" />
                  {t(I18nKey.ARTIFACTS$HISTORY)}
                </div>

                {/*
                 * Newest first. The list is stored oldest-first because it is
                 * append-only, and reversing a copy here keeps that invariant
                 * intact — `.reverse()` on the array itself would mutate the
                 * react-query cache in place, and the next render would read a
                 * history running backwards.
                 */}
                {[...detail.versions].reverse().map((version) => {
                  const isCurrent = version.version === detail.current_version;
                  return (
                    <div
                      key={version.version}
                      data-testid="artifact-version-row"
                      className="flex items-center gap-2 px-3 py-2 border-b border-[#3A3F4B]"
                    >
                      <div className="grow min-w-0">
                        <span className="block text-xs text-white">
                          {t(I18nKey.ARTIFACTS$VERSION_N, {
                            n: version.version,
                          })}
                          {isCurrent && ` · ${t(I18nKey.ARTIFACTS$CURRENT)}`}
                        </span>
                        <span className="block text-[11px] text-[#8A8F9C]">
                          {new Date(version.created_at).toLocaleString()}
                          {version.restored_from !== null &&
                            ` · ${t(I18nKey.ARTIFACTS$RESTORED_FROM, {
                              n: version.restored_from,
                            })}`}
                        </span>
                      </div>

                      {/*
                       * No restore control on the current version — it would be
                       * a no-op that still appends a version, leaving the
                       * customer with a history full of entries that changed
                       * nothing.
                       */}
                      {!isCurrent && (
                        <button
                          type="button"
                          data-testid="artifact-restore"
                          aria-label={t(I18nKey.ARTIFACTS$RESTORE_VERSION, {
                            n: version.version,
                          })}
                          disabled={isRestoring}
                          onClick={() =>
                            restore({
                              id: detail.id,
                              version: version.version,
                            })
                          }
                          className={cn(
                            "button-base p-1",
                            isRestoring
                              ? "cursor-default opacity-60"
                              : "cursor-pointer",
                          )}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {pendingDelete && (
        <ConfirmationModal
          text={t(I18nKey.ARTIFACTS$DELETE_WARNING)}
          onConfirm={() => {
            remove(pendingDelete);
            if (pendingDelete === selectedId) setSelectedId(null);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

export default ArtifactsScreen;
