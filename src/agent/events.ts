import type { ProviderUsage } from "../llm/provider.js";
import type { ApprovalRequest } from "./approval.js";
import type { ToolCall, ToolResult } from "./messages.js";

export type AgentTerminationReason =
  | "complete"
  | "aborted"
  | "provider_error"
  | "protocol_error"
  | "internal_error"
  | "max_steps";

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

export type AgentErrorCode =
  | "provider_authentication"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_network"
  | "provider_server"
  | "provider_http"
  | "provider_protocol"
  | "tool_call_protocol"
  | "tool_internal"
  | "approval_denied"
  | "internal_error";

export type AgentEvent =
  | { readonly type: "turn_start"; readonly step: number }
  | { readonly type: "assistant_delta"; readonly step: number; readonly delta: string }
  | { readonly type: "usage"; readonly step: number; readonly usage: ProviderUsage }
  | {
      readonly type: "provider_retry";
      readonly step: number;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      readonly error: AgentError;
    }
  | { readonly type: "approval_required"; readonly step: number; readonly request: ApprovalRequest }
  | {
      readonly type: "approval_resolved";
      readonly step: number;
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly approved: boolean;
    }
  | { readonly type: "tool_start"; readonly step: number; readonly toolCall: ToolCall }
  | { readonly type: "tool_end"; readonly step: number; readonly result: ToolResult }
  | { readonly type: "error"; readonly step: number; readonly error: AgentError }
  | { readonly type: "complete"; readonly step: number; readonly reason: AgentTerminationReason };
