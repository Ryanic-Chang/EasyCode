import type { AgentError, AgentEvent, AgentTerminationReason } from "../agent/events.js";
import { retryReasonText, summarizeToolCall, summarizeToolResult } from "./format.js";
import { truncateGraphemes } from "./input.js";

export const MAX_TRANSCRIPT_ITEMS = 100;
export const MAX_ASSISTANT_GRAPHEMES = 12_000;
const ASSISTANT_TRUNCATION_MARKER = "…[已截断]";

export type UiPhase = "idle" | "running" | "awaiting_approval" | "cancelling";

export type TranscriptItem =
  | { readonly id: string; readonly type: "user"; readonly task: string }
  | { readonly id: string; readonly type: "turn"; readonly step: number }
  | {
      readonly id: string;
      readonly type: "retry";
      readonly step: number;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly type: "approval";
      readonly step: number;
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly riskCategory: string;
      readonly actionSummary: string;
      readonly status: "pending" | "approved" | "denied";
    }
  | {
      readonly id: string;
      readonly type: "assistant";
      readonly step: number;
      readonly text: string;
      readonly done: boolean;
    }
  | {
      readonly id: string;
      readonly type: "tool";
      readonly step: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly detail: string;
      readonly result?: string;
      readonly status: "running" | "success" | "failure";
    }
  | { readonly id: string; readonly type: "error"; readonly error: AgentError }
  | { readonly id: string; readonly type: "complete"; readonly reason: AgentTerminationReason };

export interface UiState {
  readonly phase: UiPhase;
  readonly activeRunId?: number;
  readonly currentStep: number;
  readonly transcript: readonly TranscriptItem[];
  readonly currentError?: AgentError;
  readonly terminationReason?: AgentTerminationReason;
  readonly terminalSeen: boolean;
}

export type UiAction =
  | { readonly type: "submit"; readonly runId: number; readonly task: string }
  | { readonly type: "cancelling"; readonly runId: number }
  | { readonly type: "agent_event"; readonly runId: number; readonly event: AgentEvent };

export const INITIAL_UI_STATE: UiState = {
  phase: "idle",
  currentStep: 0,
  transcript: [],
  terminalSeen: false,
};

function bounded(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  return items.length <= MAX_TRANSCRIPT_ITEMS ? items : items.slice(items.length - MAX_TRANSCRIPT_ITEMS);
}

function finalizeAssistants(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  return items.map((item) => (item.type === "assistant" && !item.done ? { ...item, done: true } : item));
}

function appendAssistantDelta(items: readonly TranscriptItem[], runId: number, step: number, delta: string) {
  if (delta.length === 0) {
    return items;
  }
  const id = `run-${runId}-assistant-${step}`;
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    const text = truncateGraphemes(delta, MAX_ASSISTANT_GRAPHEMES, ASSISTANT_TRUNCATION_MARKER);
    return bounded([...items, { id, type: "assistant", step, text, done: false }]);
  }
  const item = items[index];
  if (item?.type !== "assistant") {
    return items;
  }
  if (item.text.endsWith(ASSISTANT_TRUNCATION_MARKER)) {
    return items;
  }
  const combined = `${item.text}${delta}`;
  const text = truncateGraphemes(combined, MAX_ASSISTANT_GRAPHEMES, ASSISTANT_TRUNCATION_MARKER);
  const next = [...items];
  next[index] = { ...item, text };
  return next;
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  if (action.type === "submit") {
    if (state.phase !== "idle") {
      return state;
    }
    return {
      phase: "running",
      activeRunId: action.runId,
      currentStep: 0,
      transcript: bounded([
        ...finalizeAssistants(state.transcript),
        { id: `run-${action.runId}-user`, type: "user", task: action.task },
      ]),
      terminalSeen: false,
    };
  }

  if (state.activeRunId !== action.runId || state.terminalSeen) {
    return state;
  }
  if (action.type === "cancelling") {
    return state.phase === "running" || state.phase === "awaiting_approval" ? { ...state, phase: "cancelling" } : state;
  }

  const event = action.event;
  switch (event.type) {
    case "turn_start":
      return {
        ...state,
        currentStep: event.step,
        transcript: bounded([
          ...finalizeAssistants(state.transcript),
          { id: `run-${action.runId}-turn-${event.step}`, type: "turn", step: event.step },
        ]),
      };
    case "assistant_delta":
      return {
        ...state,
        transcript: appendAssistantDelta(state.transcript, action.runId, event.step, event.delta),
      };
    case "usage":
      return state;
    case "provider_retry":
      return {
        ...state,
        transcript: bounded([
          ...state.transcript,
          {
            id: `run-${action.runId}-retry-${event.step}-${event.attempt}`,
            type: "retry",
            step: event.step,
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            reason: retryReasonText(event.error.code),
          },
        ]),
      };
    case "approval_required":
      return {
        ...state,
        phase: "awaiting_approval",
        transcript: bounded([
          ...finalizeAssistants(state.transcript),
          {
            id: `run-${action.runId}-approval-${event.request.approvalId}`,
            type: "approval",
            step: event.step,
            approvalId: event.request.approvalId,
            toolCallId: event.request.toolCallId,
            toolName: event.request.toolName,
            riskCategory: event.request.riskCategory,
            actionSummary: event.request.actionSummary,
            status: "pending",
          },
        ]),
      };
    case "approval_resolved":
      return {
        ...state,
        phase: "running",
        transcript: state.transcript.map((item) =>
          item.type === "approval" && item.approvalId === event.approvalId
            ? { ...item, status: event.approved ? "approved" : "denied" }
            : item,
        ),
      };
    case "tool_start":
      return {
        ...state,
        transcript: bounded([
          ...finalizeAssistants(state.transcript),
          {
            id: `run-${action.runId}-tool-${event.toolCall.id}`,
            type: "tool",
            step: event.step,
            toolCallId: event.toolCall.id,
            toolName: event.toolCall.name,
            detail: summarizeToolCall(event.toolCall),
            status: "running",
          },
        ]),
      };
    case "tool_end": {
      const id = `run-${action.runId}-tool-${event.result.toolCallId}`;
      return {
        ...state,
        transcript: state.transcript.map((item) =>
          item.id === id && item.type === "tool"
            ? {
                ...item,
                result: summarizeToolResult(event.result),
                status: event.result.isError ? "failure" : "success",
              }
            : item,
        ),
      };
    }
    case "error":
      return {
        ...state,
        currentError: event.error,
        transcript: bounded([
          ...finalizeAssistants(state.transcript),
          { id: `run-${action.runId}-error-${event.step}`, type: "error", error: event.error },
        ]),
      };
    case "complete": {
      const { activeRunId: _activeRunId, ...completedState } = state;
      return {
        ...completedState,
        phase: "idle",
        currentStep: event.step,
        transcript: bounded([
          ...finalizeAssistants(state.transcript),
          { id: `run-${action.runId}-complete`, type: "complete", reason: event.reason },
        ]),
        terminationReason: event.reason,
        terminalSeen: true,
      };
    }
  }
}
