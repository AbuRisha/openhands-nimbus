import React from "react";
import ArrowDown from "#/icons/angle-down-solid.svg?react";
import ArrowUp from "#/icons/angle-up-solid.svg?react";
import { OpenHandsEvent } from "#/types/v1/core";
import { isObservationEvent } from "#/types/v1/type-guards";
import { SuccessIndicator } from "../../features/chat/success-indicator";
import { getObservationResult } from "./event-content-helpers/get-observation-result";
import { summarizeToolCall } from "./event-content-helpers/tool-call-summary";

/**
 * One tool call, as one line.
 *
 * Collapsed it is a single row — operation, then the argument that identifies
 * the call, then a status dot. Open it renders exactly what the transcript
 * renders today, because `children` is the existing EventMessage output rather
 * than a reimplementation of it. That split is the whole design: the summary is
 * new, the detail is untouched, so nothing that already works can regress here.
 *
 * A CALL WITH NO RESULT OPENS ITSELF
 * ----------------------------------
 * No observation means the call is still running or is waiting on the user to
 * approve it. The confirmation buttons live in the detail, so leaving those
 * rows closed would strand an agent behind a chevron with no visible reason —
 * the exact trap the old grouped chip had to work around. Once the result
 * lands the row collapses on its own, which is also what makes a finished turn
 * scannable.
 */

interface ToolCallRowProps {
  action: OpenHandsEvent;
  observation?: OpenHandsEvent;
  children: React.ReactNode;
}

export function ToolCallRow({
  action,
  observation,
  children,
}: ToolCallRowProps) {
  const { label, target } = summarizeToolCall(action);

  // Deliberately not derived state: once a user opens or closes a row, that is
  // their decision and an arriving observation must not override it. Only the
  // INITIAL value depends on whether a result had landed by first render.
  const [open, setOpen] = React.useState(!observation);

  const status =
    observation && isObservationEvent(observation)
      ? getObservationResult(observation)
      : undefined;

  return (
    <div className="w-full text-sm my-0.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-neutral-800/40 cursor-pointer"
      >
        {open ? (
          <ArrowUp className="h-3 w-3 shrink-0 fill-neutral-400" />
        ) : (
          <ArrowDown className="h-3 w-3 shrink-0 fill-neutral-400" />
        )}

        <span className="font-semibold text-neutral-200 shrink-0">{label}</span>

        {/*
         * min-w-0 with truncate, not overflow-hidden on the row: without the
         * min-width reset a flex child refuses to shrink below its content, so
         * a long command pushes the status dot off the edge instead of
         * ellipsing. font-mono because every target is a path, a pattern or a
         * command.
         */}
        {target && (
          <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">
            {target}
          </span>
        )}

        <span className="ml-auto shrink-0">
          {status && <SuccessIndicator status={status} />}
        </span>
      </button>

      {open && (
        <div className="border-l-2 border-neutral-700 pl-3 ml-1.5 mt-1">
          {children}
        </div>
      )}
    </div>
  );
}
