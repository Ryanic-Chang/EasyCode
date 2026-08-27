import type { ToolCall, ToolResult } from "./messages.js";

export type AgentTerminationReason =
  | "complete"
  | "aborted"
  | "provider_error"
  | "protocol_error"
  | "internal_error"
  | "max_steps";

export interface AgentError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export type AgentEvent =
  | { readonly type: "turn_start"; readonly step: number }
  | { readonly type: "assistant_delta"; readonly step: number; readonly delta: string }
  | { readonly type: "tool_start"; readonly step: number; readonly toolCall: ToolCall }
  | { readonly type: "tool_end"; readonly step: number; readonly result: ToolResult }
  | { readonly type: "error"; readonly step: number; readonly error: AgentError }
  | { readonly type: "complete"; readonly step: number; readonly reason: AgentTerminationReason };
