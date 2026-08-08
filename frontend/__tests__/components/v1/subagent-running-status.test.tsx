import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentObservationContent } from "#/components/v1/chat/subagent/subagent-observation-content";
import { ObservationEvent } from "#/types/v1/core";
import { TaskObservation } from "#/types/v1/core/base/observation";

const event = (status: string): ObservationEvent<TaskObservation> =>
  ({
    id: "e1",
    timestamp: "2026-08-07T00:00:00Z",
    source: "environment",
    kind: "ObservationEvent",
    action_id: "a1",
    tool_name: "task",
    tool_call_id: "c1",
    observation: {
      kind: "TaskObservation",
      content: [{ type: "text", text: "partial findings" }],
      is_error: false,
      task_id: "t-1",
      subagent: "bash-runner",
      status,
    },
  }) as unknown as ObservationEvent<TaskObservation>;

describe("sub-agent running status", () => {
  /**
   * THE GAP THIS CLOSES. `TaskManager` emits TaskStatus.RUNNING
   * (tools/task/manager.py:283), so an observation can arrive while the
   * sub-agent is still working. `status` was carried on the wire and rendered
   * nowhere, so an in-progress task looked identical to a finished one — a
   * "Result" heading over a partial answer, with nothing saying more is coming.
   */
  it("marks a running task as still running", () => {
    render(<SubagentObservationContent event={event("running")} />);

    expect(screen.getByTestId("subagent-running")).toBeInTheDocument();
    expect(
      screen.getByText("SUBAGENT_OBSERVATION$STILL_RUNNING"),
    ).toBeInTheDocument();
  });

  it("labels the body as partial while running", () => {
    render(<SubagentObservationContent event={event("running")} />);

    expect(
      screen.getByText("SUBAGENT_OBSERVATION$PARTIAL_RESULT"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("SUBAGENT_OBSERVATION$RESULT"),
    ).not.toBeInTheDocument();
  });

  it.each(["completed", "finished", "error", "failed"])(
    "treats %s as finished",
    (status) => {
      render(<SubagentObservationContent event={event(status)} />);

      expect(screen.queryByTestId("subagent-running")).not.toBeInTheDocument();
    },
  );

  it("is case- and whitespace-insensitive", () => {
    render(<SubagentObservationContent event={event("  COMPLETED ")} />);

    expect(screen.queryByTestId("subagent-running")).not.toBeInTheDocument();
  });

  /**
   * The conservative direction. An unrecognised status renders as RUNNING
   * rather than finished, because the alternative — silently calling an unknown
   * state "done" — is the bug being fixed. A permanent "still running" label is
   * visible and wrong; a missing one is invisible and wrong.
   */
  it("treats an unrecognised status as still running", () => {
    render(<SubagentObservationContent event={event("queued")} />);

    expect(screen.getByTestId("subagent-running")).toBeInTheDocument();
  });

  /** An absent status is the pre-existing shape and must not regress. */
  it("shows nothing extra when status is empty", () => {
    render(<SubagentObservationContent event={event("")} />);

    expect(screen.queryByTestId("subagent-running")).not.toBeInTheDocument();
    expect(screen.getByText("SUBAGENT_OBSERVATION$RESULT")).toBeInTheDocument();
  });

  it("still renders subagent and task id", () => {
    render(<SubagentObservationContent event={event("running")} />);

    expect(screen.getByText("bash-runner")).toBeInTheDocument();
    expect(screen.getByText("t-1")).toBeInTheDocument();
  });
});
