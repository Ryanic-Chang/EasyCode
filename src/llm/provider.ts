export type JsonObject = Readonly<Record<string, unknown>>;

export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

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

export interface ProviderError {
  readonly code: string;
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
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "length" }
  | { readonly type: "error"; readonly error: ProviderError };

export interface Provider {
  readonly name: string;

  stream(request: ProviderRequest, options?: ProviderStreamOptions): AsyncIterable<ProviderEvent>;
}
