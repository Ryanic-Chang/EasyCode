import { randomUUID } from "node:crypto";

import type {
  Provider,
  ProviderError,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderToolDefinition,
  ProviderUsage,
} from "../llm/provider.js";
import { Redactor } from "../security/redaction.js";
import { sanitizeToolExecutionResult } from "../security/tool-result.js";
import type { PreparedTool, ToolRegistry } from "../tools/registry.js";
import { type ApprovalGate, type ApprovalRequest, DenyApprovalGate } from "./approval.js";
import type { AgentError, AgentEvent, AgentTerminationReason } from "./events.js";
import type { AssistantMessage, Message, ToolCall, ToolResult } from "./messages.js";

export interface AgentLoopConfig {
  readonly provider: Provider;
  readonly tools: ToolRegistry;
  readonly model: string;
  readonly cwd: string;
  readonly maxSteps: number;
  readonly approvalGate?: ApprovalGate;
  readonly approvalIdFactory?: () => string;
  readonly redactor?: Redactor;
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
  code: "tool_call_protocol",
  message: "模型返回的工具调用无效，工具未执行；请重新描述任务后再试。",
  recoverable: false,
};

const TOOL_INTERNAL_ERROR: AgentError = {
  code: "tool_internal",
  message: "工具发生内部错误，已停止本次任务；请检查工具实现或重新尝试。",
  recoverable: false,
};

const INTERNAL_ERROR: AgentError = {
  code: "internal_error",
  message: "内部状态发生异常，已安全停止；请重新启动 EasyCode 后再试。",
  recoverable: true,
};

const PROVIDER_ERRORS: Readonly<Record<ProviderError["code"], AgentError>> = {
  provider_authentication: {
    code: "provider_authentication",
    message: "模型服务鉴权失败，请检查或轮换 API 凭据后重试。",
    recoverable: true,
  },
  provider_rate_limit: {
    code: "provider_rate_limit",
    message: "模型服务请求频率受限，请稍后重试。",
    recoverable: true,
  },
  provider_timeout: {
    code: "provider_timeout",
    message: "模型请求超时，请检查网络或 base URL，稍后重试。",
    recoverable: true,
  },
  provider_network: {
    code: "provider_network",
    message: "无法连接模型服务，请检查网络或 base URL 后重试。",
    recoverable: true,
  },
  provider_server: {
    code: "provider_server",
    message: "模型服务暂时不可用，请稍后重试。",
    recoverable: true,
  },
  provider_http: {
    code: "provider_http",
    message: "模型服务拒绝了请求，请检查 base URL、模型名称或请求参数。",
    recoverable: false,
  },
  provider_protocol: {
    code: "provider_protocol",
    message: "模型服务响应与已声明协议不兼容，请检查服务地址或模型。",
    recoverable: false,
  },
};

function snapshot(reason: AgentTerminationReason, step: number, messages: readonly Message[]): AgentRunResult {
  return { reason, step, messages: [...messages] };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTokenCount(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function isValidUsage(usage: ProviderUsage): boolean {
  const allowed = new Set(["inputTokens", "outputTokens", "totalTokens"]);
  return (
    Object.keys(usage).every((key) => allowed.has(key)) &&
    isValidTokenCount(usage.inputTokens) &&
    isValidTokenCount(usage.outputTokens) &&
    isValidTokenCount(usage.totalTokens)
  );
}

function isNonEmptyField(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function isAbort(signal: AbortSignal): boolean {
  return signal.aborted;
}

function providerError(error: ProviderError): AgentError {
  const mapped = PROVIDER_ERRORS[error.code];
  return error.code === "provider_http" && error.retryable ? { ...mapped, recoverable: true } : mapped;
}

function approvalId(factory: () => string): string {
  try {
    const value = factory();
    if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
      return value;
    }
  } catch {
    // 使用无模型、用户或 workspace 数据的本地随机 ID 回退。
  }
  return `approval-${randomUUID()}`;
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
  readonly #approvalGate: ApprovalGate;
  readonly #approvalIdFactory: () => string;
  readonly #redactor: Redactor;

  constructor(config: AgentLoopConfig) {
    if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1) {
      throw new RangeError("maxSteps 必须是大于等于 1 的整数");
    }
    this.#provider = config.provider;
    this.#tools = config.tools;
    this.#model = config.model;
    this.#cwd = config.cwd;
    this.#maxSteps = config.maxSteps;
    this.#approvalGate = config.approvalGate ?? new DenyApprovalGate();
    this.#approvalIdFactory = config.approvalIdFactory ?? (() => `approval-${randomUUID()}`);
    this.#redactor = config.redactor ?? new Redactor();
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
      let usageSeen = false;
      let phase: "provider" | "validation" | "approval" | "tool" = "provider";

      try {
        const stream = this.#provider.stream(buildRequest(this.#model, messages, this.#tools), { signal });
        for await (const event of stream) {
          signal.throwIfAborted();
          if (finishReason !== undefined && event.type !== "usage") {
            throw new ProtocolViolation("finish 之后不能再出现 ProviderEvent");
          }

          switch (event.type) {
            case "start":
              break;
            case "retry":
              yield {
                type: "provider_retry",
                step,
                attempt: event.attempt,
                maxRetries: event.maxRetries,
                delayMs: event.delayMs,
                error: providerError(event.error),
              };
              break;
            case "text_delta":
              content += event.delta;
              yield { type: "assistant_delta", step, delta: event.delta };
              break;
            case "usage":
              if (finishReason === undefined || usageSeen || !isValidUsage(event.usage)) {
                throw new ProtocolViolation("usage 必须在 finish 后出现且最多一次");
              }
              usageSeen = true;
              yield { type: "usage", step, usage: event.usage };
              break;
            case "tool_call":
            case "tool_call_delta":
              addToolCallEvent(buffers, event);
              break;
            case "finish":
              finishReason = event.reason;
              break;
            case "error": {
              yield { type: "error", step, error: providerError(event.error) };
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
          const requirement = prepared.tool.approvalRequirement;
          if (requirement !== undefined) {
            const request: ApprovalRequest = {
              approvalId: approvalId(this.#approvalIdFactory),
              step,
              toolCallId: prepared.call.id,
              toolName: prepared.call.name,
              riskCategory: this.#redactor.redactText(requirement.riskCategory, 128),
              actionSummary: this.#redactor.redactText(requirement.actionSummary, 1024),
            };
            yield { type: "approval_required", step, request };
            phase = "approval";
            const decision = await this.#approvalGate.request(request, { signal });
            signal.throwIfAborted();
            phase = "tool";
            const approved = decision.approvalId === request.approvalId && decision.approved === true;
            yield {
              type: "approval_resolved",
              step,
              approvalId: request.approvalId,
              toolCallId: prepared.call.id,
              toolName: prepared.call.name,
              approved,
            };
            if (!approved) {
              const denied: ToolResult = {
                toolCallId: prepared.call.id,
                toolName: prepared.call.name,
                output: "用户拒绝了本次高风险工具调用。请调整方案或提出更安全的操作。",
                isError: true,
                metadata: { kind: "approval_denied", code: "approval_denied" },
              };
              messages.push({ role: "tool", result: denied });
              yield { type: "tool_end", step, result: denied };
              continue;
            }
          }
          yield { type: "tool_start", step, toolCall: prepared.call };
          const execution = sanitizeToolExecutionResult(
            await prepared.tool.execute({ cwd: this.#cwd, signal }),
            this.#redactor,
          );
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
            error: PROVIDER_ERRORS.provider_network,
          };
          yield { type: "complete", step, reason: "provider_error" };
          return snapshot("provider_error", step, messages);
        }

        if (phase === "approval") {
          yield { type: "error", step, error: INTERNAL_ERROR };
          yield { type: "complete", step, reason: "internal_error" };
          return snapshot("internal_error", step, messages);
        }

        yield { type: "error", step, error: TOOL_INTERNAL_ERROR };
        yield { type: "complete", step, reason: "internal_error" };
        return snapshot("internal_error", step, messages);
      }
    }
  }
}
