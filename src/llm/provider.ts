export type JsonObject = Readonly<Record<string, unknown>>;

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ProviderSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface ProviderUserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface ProviderAssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ProviderToolCall[];
}

export interface ProviderToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: JsonObject;
}

export type ProviderMessage =
  | ProviderSystemMessage
  | ProviderUserMessage
  | ProviderAssistantMessage
  | ProviderToolMessage;

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
}

export interface ProviderStreamOptions {
  readonly signal?: AbortSignal;
}

export type ProviderErrorCode =
  | "provider_authentication"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_network"
  | "provider_server"
  | "provider_http"
  | "provider_protocol";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type ProviderEvent =
  | { readonly type: "start" }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | {
      readonly type: "tool_call";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "length" }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      readonly error: ProviderError;
    }
  | { readonly type: "error"; readonly error: ProviderError };

export interface Provider {
  readonly name: string;

  stream(request: ProviderRequest, options?: ProviderStreamOptions): AsyncIterable<ProviderEvent>;
}
