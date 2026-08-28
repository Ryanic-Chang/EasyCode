import type { AgentErrorCode, AgentEvent, AgentTerminationReason } from "../agent/events.js";

export type MonotonicClock = () => number;

export interface UsageMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly roundsWithUsage: number;
  readonly complete: boolean;
}

export interface DurationMetrics {
  readonly totalMs: number;
  readonly providerMs: number;
  readonly toolMs: number;
  readonly approvalMs: number;
}

export interface AgentMetrics {
  readonly providerRounds: number;
  readonly providerAttempts: number;
  readonly providerRetries: number;
  readonly toolCallsRequested: number;
  readonly toolExecutions: number;
  readonly toolSuccesses: number;
  readonly toolFailures: number;
  readonly approvalRequests: number;
  readonly approvalAllowed: number;
  readonly approvalDenied: number;
  readonly usage: UsageMetrics;
  readonly durations: DurationMetrics;
  readonly terminationReason?: AgentTerminationReason;
  readonly errorCode?: AgentErrorCode;
}

interface UsageSample {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

function sumComplete(samples: readonly UsageSample[], key: keyof UsageSample, rounds: number): number | undefined {
  if (samples.length !== rounds || samples.some((sample) => sample[key] === undefined)) {
    return undefined;
  }
  const total = samples.reduce((sum, sample) => sum + (sample[key] ?? 0), 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

export class MetricsCollector {
  readonly #clock: MonotonicClock;
  readonly #requestedToolCalls = new Set<string>();
  readonly #startedTools = new Map<string, number>();
  readonly #pendingApprovals = new Map<string, number>();
  readonly #usageSamples: UsageSample[] = [];
  #firstAt: number | undefined;
  #lastAt: number | undefined;
  #providerStartedAt: number | undefined;
  #providerRounds = 0;
  #providerAttempts = 0;
  #providerRetries = 0;
  #toolExecutions = 0;
  #toolSuccesses = 0;
  #toolFailures = 0;
  #approvalRequests = 0;
  #approvalAllowed = 0;
  #approvalDenied = 0;
  #providerMs = 0;
  #toolMs = 0;
  #approvalMs = 0;
  #terminationReason: AgentTerminationReason | undefined;
  #errorCode: AgentErrorCode | undefined;

  constructor(clock: MonotonicClock = () => performance.now()) {
    this.#clock = clock;
  }

  consume(event: AgentEvent): void {
    const at = this.#clock();
    if (!Number.isFinite(at) || (this.#lastAt !== undefined && at < this.#lastAt)) {
      throw new Error("metrics clock 必须返回单调有限数值");
    }
    this.#firstAt ??= at;
    this.#lastAt = at;

    switch (event.type) {
      case "turn_start":
        this.#closeProvider(at);
        this.#providerRounds += 1;
        this.#providerAttempts += 1;
        this.#providerStartedAt = at;
        break;
      case "provider_retry":
        this.#providerRetries += 1;
        this.#providerAttempts += 1;
        break;
      case "usage":
        this.#usageSamples.push(event.usage);
        break;
      case "approval_required":
        this.#closeProvider(at);
        this.#requestedToolCalls.add(event.request.toolCallId);
        this.#approvalRequests += 1;
        this.#pendingApprovals.set(event.request.approvalId, at);
        break;
      case "approval_resolved": {
        const startedAt = this.#pendingApprovals.get(event.approvalId);
        if (startedAt !== undefined) {
          this.#approvalMs += at - startedAt;
          this.#pendingApprovals.delete(event.approvalId);
        }
        if (event.approved) {
          this.#approvalAllowed += 1;
        } else {
          this.#approvalDenied += 1;
        }
        break;
      }
      case "tool_start":
        this.#closeProvider(at);
        this.#requestedToolCalls.add(event.toolCall.id);
        this.#toolExecutions += 1;
        this.#startedTools.set(event.toolCall.id, at);
        break;
      case "tool_end": {
        this.#requestedToolCalls.add(event.result.toolCallId);
        const startedAt = this.#startedTools.get(event.result.toolCallId);
        if (startedAt !== undefined) {
          this.#toolMs += at - startedAt;
          this.#startedTools.delete(event.result.toolCallId);
          if (event.result.isError) {
            this.#toolFailures += 1;
          } else {
            this.#toolSuccesses += 1;
          }
        }
        break;
      }
      case "error":
        this.#closeProvider(at);
        this.#errorCode = event.error.code;
        break;
      case "complete":
        this.#closeProvider(at);
        this.#closePending(at);
        this.#terminationReason = event.reason;
        break;
      case "assistant_delta":
        break;
    }
  }

  snapshot(): AgentMetrics {
    const inputTokens = sumComplete(this.#usageSamples, "inputTokens", this.#providerRounds);
    const outputTokens = sumComplete(this.#usageSamples, "outputTokens", this.#providerRounds);
    const totalTokens = sumComplete(this.#usageSamples, "totalTokens", this.#providerRounds);
    return {
      providerRounds: this.#providerRounds,
      providerAttempts: this.#providerAttempts,
      providerRetries: this.#providerRetries,
      toolCallsRequested: this.#requestedToolCalls.size,
      toolExecutions: this.#toolExecutions,
      toolSuccesses: this.#toolSuccesses,
      toolFailures: this.#toolFailures,
      approvalRequests: this.#approvalRequests,
      approvalAllowed: this.#approvalAllowed,
      approvalDenied: this.#approvalDenied,
      usage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        roundsWithUsage: this.#usageSamples.length,
        complete:
          this.#providerRounds > 0 &&
          inputTokens !== undefined &&
          outputTokens !== undefined &&
          totalTokens !== undefined,
      },
      durations: {
        totalMs: this.#firstAt === undefined || this.#lastAt === undefined ? 0 : this.#lastAt - this.#firstAt,
        providerMs: this.#providerMs,
        toolMs: this.#toolMs,
        approvalMs: this.#approvalMs,
      },
      ...(this.#terminationReason === undefined ? {} : { terminationReason: this.#terminationReason }),
      ...(this.#errorCode === undefined ? {} : { errorCode: this.#errorCode }),
    };
  }

  #closeProvider(at: number): void {
    if (this.#providerStartedAt !== undefined) {
      this.#providerMs += at - this.#providerStartedAt;
      this.#providerStartedAt = undefined;
    }
  }

  #closePending(at: number): void {
    for (const startedAt of this.#startedTools.values()) {
      this.#toolMs += at - startedAt;
    }
    this.#startedTools.clear();
    for (const startedAt of this.#pendingApprovals.values()) {
      this.#approvalMs += at - startedAt;
    }
    this.#pendingApprovals.clear();
  }
}
