import type {
  Provider,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderToolDefinition,
} from "../llm/provider.js";
import type { PreparedTool, ToolRegistry } from "../tools/registry.js";
import type { AgentError, AgentEvent, AgentTerminationReason } from "./events.js";
import type { AssistantMessage, Message, ToolCall, ToolResult } from "./messages.js";

export interface AgentLoopConfig {
  readonly provider: Provider;
  readonly tools: ToolRegistry;
  readonly model: string;
  readonly cwd: string;
  readonly maxSteps: number;
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
}

export interface AgentRunResult {
  readonly reason: AgentTerminationReason;
  readonly step: number;
  readonly messages: readonly Message[];
}

interface ToolCallDeltaBuffer {
  readonly mode: "delta";
  id: string | undefined;
  name: string | undefined;
  argumentsText: string;
}

interface CompleteToolCallBuffer {
  readonly mode: "complete";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

type ToolCallBuffer = ToolCallDeltaBuffer | CompleteToolCallBuffer;

interface PreparedCall {
  readonly call: ToolCall;
  readonly tool: PreparedTool;
}

class ProtocolViolation extends Error {}

const PROTOCOL_ERROR: AgentError = {
  code: "protocol_error",
  message: "模型返回的工具调用无效，已停止执行。",
  recoverable: false,
};

const PROVIDER_ERROR_MESSAGE = "模型服务暂时不可用，请稍后重试。";

const INTERNAL_ERROR: AgentError = {
  code: "internal_error",
  message: "工具执行失败，已停止本次任务。",
  recoverable: false,
};

function snapshot(reason: AgentTerminationReason, step: number, messages: readonly Message[]): AgentRunResult {
  return { reason, step, messages: [...messages] };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyField(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function isAbort(signal: AbortSignal): boolean {
  return signal.aborted;
}

function updateStableField(current: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming === undefined) {
    return current;
  }
  if (current !== undefined && current !== incoming) {
    throw new ProtocolViolation("同一 ToolCall index 的字段发生冲突");
  }
  return incoming;
}

function addToolCallEvent(buffers: Map<number, ToolCallBuffer>, event: ProviderEvent): void {
  if (event.type !== "tool_call" && event.type !== "tool_call_delta") {
    return;
  }
  if (!Number.isInteger(event.index) || event.index < 0) {
    throw new ProtocolViolation("ToolCall index 必须是非负整数");
  }

  const current = buffers.get(event.index);
  if (event.type === "tool_call") {
    if (current !== undefined) {
      throw new ProtocolViolation("同一 ToolCall index 不能混用完整事件与增量事件");
    }
    buffers.set(event.index, {
      mode: "complete",
      id: event.id,
      name: event.name,
      arguments: event.arguments,
    });
    return;
  }

  if (current?.mode === "complete") {
    throw new ProtocolViolation("同一 ToolCall index 不能混用完整事件与增量事件");
  }

  const buffer: ToolCallDeltaBuffer = current ?? {
    mode: "delta",
    id: undefined,
    name: undefined,
    argumentsText: "",
  };
  buffer.id = updateStableField(buffer.id, event.id);
  buffer.name = updateStableField(buffer.name, event.name);
  buffer.argumentsText += event.argumentsDelta ?? "";
  buffers.set(event.index, buffer);
}

function parseArguments(buffer: ToolCallBuffer): Readonly<Record<string, unknown>> {
  if (buffer.mode === "complete") {
    if (!isJsonObject(buffer.arguments)) {
      throw new ProtocolViolation("完整 ToolCall arguments 必须是 JSON object");
    }
    return buffer.arguments;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.argumentsText);
  } catch {
    throw new ProtocolViolation("增量 ToolCall arguments 不是完整 JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new ProtocolViolation("ToolCall arguments 必须是 JSON object");
  }
  return parsed;
}

function assembleToolCalls(buffers: ReadonlyMap<number, ToolCallBuffer>): readonly ToolCall[] {
  const ordered = [...buffers.entries()].sort(([left], [right]) => left - right);
  const ids = new Set<string>();

  return ordered.map(([index, buffer], position) => {
    if (index !== position) {
      throw new ProtocolViolation("ToolCall index 必须从 0 开始且连续");
    }
    const id = buffer.id;
    const name = buffer.name;
    if (id === undefined || name === undefined || !isNonEmptyField(id) || !isNonEmptyField(name)) {
      throw new ProtocolViolation("ToolCall 缺少有效的 id 或 name");
    }
    if (ids.has(id)) {
      throw new ProtocolViolation("ToolCall id 不能重复");
    }
    ids.add(id);

    return {
      id,
      name,
      arguments: parseArguments(buffer),
    };
  });
}

function toProviderMessage(message: Message): ProviderMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls.map((call) => ({ ...call })),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.result.toolCallId,
        toolName: message.result.toolName,
        content: message.result.output,
        isError: message.result.isError,
        ...(message.result.metadata === undefined ? {} : { metadata: message.result.metadata }),
      };
  }
}

function toProviderTools(registry: ToolRegistry): readonly ProviderToolDefinition[] {
  return registry.list().map((tool) => ({ ...tool }));
}

function buildRequest(model: string, messages: readonly Message[], tools: ToolRegistry): ProviderRequest {
  return {
    model,
    messages: messages.map(toProviderMessage),
    tools: toProviderTools(tools),
  };
}

function prepareCalls(registry: ToolRegistry, calls: readonly ToolCall[]): readonly PreparedCall[] {
  return calls.map((call) => {
    let tool: PreparedTool | undefined;
    try {
      tool = registry.prepare(call.name, call.arguments);
    } catch {
      throw new ProtocolViolation("ToolCall 参数未通过工具解析");
    }
    if (tool === undefined) {
      throw new ProtocolViolation("ToolCall 指向未注册工具");
    }
    return { call, tool };
  });
}

export class AgentLoop {
  readonly #provider: Provider;
  readonly #tools: ToolRegistry;
  readonly #model: string;
  readonly #cwd: string;
  readonly #maxSteps: number;

  constructor(config: AgentLoopConfig) {
    if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1) {
      throw new RangeError("maxSteps 必须是大于等于 1 的整数");
    }
    this.#provider = config.provider;
    this.#tools = config.tools;
    this.#model = config.model;
    this.#cwd = config.cwd;
    this.#maxSteps = config.maxSteps;
  }

  async *run(
    initialMessages: readonly Message[],
    options: AgentRunOptions = {},
  ): AsyncGenerator<AgentEvent, AgentRunResult> {
    const messages: Message[] = [...initialMessages];
    const signal = options.signal ?? new AbortController().signal;
    let step = 0;

    while (true) {
      if (signal.aborted) {
        yield { type: "complete", step, reason: "aborted" };
        return snapshot("aborted", step, messages);
      }
      if (step >= this.#maxSteps) {
        yield { type: "complete", step, reason: "max_steps" };
        return snapshot("max_steps", step, messages);
      }

      step += 1;
      yield { type: "turn_start", step };

      let content = "";
      const buffers = new Map<number, ToolCallBuffer>();
      let finishReason: "stop" | "tool_calls" | "length" | undefined;
      let phase: "provider" | "validation" | "tool" = "provider";

      try {
        const stream = this.#provider.stream(buildRequest(this.#model, messages, this.#tools), { signal });
        for await (const event of stream) {
          signal.throwIfAborted();
          if (finishReason !== undefined) {
            throw new ProtocolViolation("finish 之后不能再出现 ProviderEvent");
          }

          switch (event.type) {
            case "start":
              break;
            case "text_delta":
              content += event.delta;
              yield { type: "assistant_delta", step, delta: event.delta };
              break;
            case "tool_call":
            case "tool_call_delta":
              addToolCallEvent(buffers, event);
              break;
            case "finish":
              finishReason = event.reason;
              break;
            case "error": {
              const providerError: AgentError = {
                code: "provider_error",
                message: PROVIDER_ERROR_MESSAGE,
                recoverable: event.error.retryable,
              };
              yield { type: "error", step, error: providerError };
              yield { type: "complete", step, reason: "provider_error" };
              return snapshot("provider_error", step, messages);
            }
          }
        }

        signal.throwIfAborted();
        phase = "validation";
        if (finishReason === undefined || finishReason === "length") {
          throw new ProtocolViolation("Provider 响应没有可提交的结束原因");
        }
        if (finishReason === "stop") {
          if (buffers.size > 0) {
            throw new ProtocolViolation("stop 响应不能包含 ToolCall");
          }
          const assistantMessage: AssistantMessage = { role: "assistant", content, toolCalls: [] };
          messages.push(assistantMessage);
          yield { type: "complete", step, reason: "complete" };
          return snapshot("complete", step, messages);
        }
        if (buffers.size === 0) {
          throw new ProtocolViolation("tool_calls 响应没有 ToolCall");
        }

        const calls = assembleToolCalls(buffers);
        const preparedCalls = prepareCalls(this.#tools, calls);
        const assistantMessage: AssistantMessage = { role: "assistant", content, toolCalls: calls };
        messages.push(assistantMessage);

        phase = "tool";
        for (const prepared of preparedCalls) {
          signal.throwIfAborted();
          yield { type: "tool_start", step, toolCall: prepared.call };
          const execution = await prepared.tool.execute({ cwd: this.#cwd, signal });
          signal.throwIfAborted();

          const result: ToolResult = {
            toolCallId: prepared.call.id,
            toolName: prepared.call.name,
            output: execution.output,
            isError: execution.isError,
            ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
          };
          messages.push({ role: "tool", result });
          yield { type: "tool_end", step, result };
        }
      } catch (error) {
        if (isAbort(signal)) {
          yield { type: "complete", step, reason: "aborted" };
          return snapshot("aborted", step, messages);
        }
        if (error instanceof ProtocolViolation || phase === "validation") {
          yield { type: "error", step, error: PROTOCOL_ERROR };
          yield { type: "complete", step, reason: "protocol_error" };
          return snapshot("protocol_error", step, messages);
        }
        if (phase === "provider") {
          yield {
            type: "error",
            step,
            error: { code: "provider_error", message: PROVIDER_ERROR_MESSAGE, recoverable: false },
          };
          yield { type: "complete", step, reason: "provider_error" };
          return snapshot("provider_error", step, messages);
        }

        yield { type: "error", step, error: INTERNAL_ERROR };
        yield { type: "complete", step, reason: "internal_error" };
        return snapshot("internal_error", step, messages);
      }
    }
  }
}
