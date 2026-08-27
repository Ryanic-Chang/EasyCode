import type { ProviderEvent, ProviderMessage, ProviderRequest } from "../provider.js";
import { OpenAICompatibleProtocolError } from "./protocol-error.js";

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stringifyJson(value: unknown): string {
  try {
    const result = JSON.stringify(value, (_key, current: unknown) => {
      if (
        current === undefined ||
        typeof current === "bigint" ||
        typeof current === "function" ||
        typeof current === "symbol" ||
        (typeof current === "number" && !Number.isFinite(current))
      ) {
        throw new OpenAICompatibleProtocolError();
      }
      return current;
    });
    if (result === undefined) {
      throw new OpenAICompatibleProtocolError();
    }
    return result;
  } catch (error) {
    if (error instanceof OpenAICompatibleProtocolError) {
      throw error;
    }
    throw new OpenAICompatibleProtocolError();
  }
}

function mapMessage(message: ProviderMessage): JsonRecord {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: stringifyJson(call.arguments) },
              })),
            }),
      };
    case "tool": {
      const envelope = {
        easycode_tool_result: {
          tool_name: message.toolName,
          is_error: message.isError,
          output: message.content,
          ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
        },
      };
      return { role: "tool", tool_call_id: message.toolCallId, content: stringifyJson(envelope) };
    }
  }
}

export function createChatCompletionsBody(request: ProviderRequest): string {
  const body = {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: request.messages.map(mapMessage),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
  };
  return stringifyJson(body);
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new OpenAICompatibleProtocolError();
  }
  return value;
}

function parseToolCallDelta(value: unknown): ProviderEvent {
  if (!isRecord(value) || !isNonNegativeInteger(value.index)) {
    throw new OpenAICompatibleProtocolError();
  }
  if (value.type !== undefined && value.type !== "function") {
    throw new OpenAICompatibleProtocolError();
  }
  if (value.function !== undefined && value.function !== null && !isRecord(value.function)) {
    throw new OpenAICompatibleProtocolError();
  }

  const functionDelta = isRecord(value.function) ? value.function : {};
  const id = optionalString(value, "id");
  const name = optionalString(functionDelta, "name");
  const argumentsDelta = optionalString(functionDelta, "arguments");

  return {
    type: "tool_call_delta",
    index: value.index,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
  };
}

function parseFinishReason(value: unknown): ProviderEvent | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "stop" || value === "tool_calls" || value === "length") {
    return { type: "finish", reason: value };
  }
  throw new OpenAICompatibleProtocolError();
}

export interface ParsedChunk {
  readonly events: readonly ProviderEvent[];
  readonly usageOnly: boolean;
}

export function parseChatCompletionChunk(payload: string): ParsedChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new OpenAICompatibleProtocolError();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new OpenAICompatibleProtocolError();
  }
  if (parsed.choices.length === 0) {
    if (!isRecord(parsed.usage)) {
      throw new OpenAICompatibleProtocolError();
    }
    return { events: [], usageOnly: true };
  }
  if (parsed.choices.length !== 1) {
    throw new OpenAICompatibleProtocolError();
  }

  const choice = parsed.choices[0];
  if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta) || !("finish_reason" in choice)) {
    throw new OpenAICompatibleProtocolError();
  }
  const delta = choice.delta;
  if (delta.role !== undefined && delta.role !== "assistant") {
    throw new OpenAICompatibleProtocolError();
  }
  if (delta.function_call !== undefined && delta.function_call !== null) {
    throw new OpenAICompatibleProtocolError();
  }

  const events: ProviderEvent[] = [];
  const content = optionalString(delta, "content");
  if (content !== undefined && content.length > 0) {
    events.push({ type: "text_delta", delta: content });
  }

  const toolCalls = delta.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null) {
    if (!Array.isArray(toolCalls)) {
      throw new OpenAICompatibleProtocolError();
    }
    events.push(...toolCalls.map(parseToolCallDelta));
  }

  const finish = parseFinishReason(choice.finish_reason);
  if (finish !== undefined) {
    events.push(finish);
  }
  return { events, usageOnly: false };
}
