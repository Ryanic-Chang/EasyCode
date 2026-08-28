import { randomUUID } from "node:crypto";

import type { EasyCodeConfig } from "../../config/config.js";
import { type SafeLogger, SILENT_LOGGER, safeLog } from "../../security/logger.js";
import { Redactor } from "../../security/redaction.js";
import type { Provider, ProviderError, ProviderEvent, ProviderRequest, ProviderStreamOptions } from "../provider.js";
import { parseRetryAfter, RetryPolicy, type RetryPolicyConfig, type RetrySleep } from "../retry.js";
import { OpenAICompatibleProtocolError } from "./protocol-error.js";
import { parseSseData } from "./sse.js";
import { createChatCompletionsBody, parseChatCompletionChunk } from "./wire.js";

export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface OpenAICompatibleProviderOptions {
  readonly fetch?: FetchTransport;
  readonly retry?: RetryPolicyConfig;
  readonly requestTimeoutMs?: number;
  readonly random?: () => number;
  readonly sleep?: RetrySleep;
  readonly now?: () => number;
  readonly requestIdFactory?: () => string;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeout?: (handle: TimerHandle) => void;
  readonly logger?: SafeLogger;
  readonly redactor?: Redactor;
}

const DEFAULT_RETRY: RetryPolicyConfig = { maxRetries: 2, baseDelayMs: 500 };
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const ERRORS = {
  authentication: {
    code: "provider_authentication",
    message: "模型服务鉴权失败，请检查或轮换 API 凭据后重试。",
    retryable: false,
  },
  rateLimit: {
    code: "provider_rate_limit",
    message: "模型服务请求频率受限，请稍后重试。",
    retryable: true,
  },
  timeout: {
    code: "provider_timeout",
    message: "模型请求超时，请检查网络或 base URL，稍后重试。",
    retryable: true,
  },
  server: {
    code: "provider_server",
    message: "模型服务暂时不可用，请稍后重试。",
    retryable: true,
  },
  http: {
    code: "provider_http",
    message: "模型服务拒绝了请求，请检查 base URL、模型名称或请求参数。",
    retryable: false,
  },
  network: {
    code: "provider_network",
    message: "无法连接模型服务，请检查网络或 base URL 后重试。",
    retryable: true,
  },
  protocol: {
    code: "provider_protocol",
    message: "模型服务响应与已声明的 OpenAI-compatible 协议不兼容，请检查服务地址或模型。",
    retryable: false,
  },
} as const satisfies Readonly<Record<string, ProviderError>>;

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  cleanup(): void;
}

function endpointFor(baseUrl: URL): string {
  const endpoint = new URL(baseUrl.toString());
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${basePath}/chat/completions`;
  return endpoint.toString();
}

function classifyHttpStatus(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ERRORS.authentication;
  }
  if (status === 408) {
    return ERRORS.timeout;
  }
  if (status === 429) {
    return ERRORS.rateLimit;
  }
  if (status >= 500 && status <= 599) {
    return ERRORS.server;
  }
  return { ...ERRORS.http, retryable: status === 409 };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 响应正文不参与分类；清理失败也不能覆盖稳定结果。
  }
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function safeRequestId(factory: () => string): string {
  try {
    const value = factory();
    if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
      return value;
    }
  } catch {
    // 使用无用户数据的本地随机 ID 回退。
  }
  return `ec-${randomUUID()}`;
}

function safeServerRequestId(headers: Headers): string | undefined {
  const value = headers.get("x-request-id");
  return value !== null && /^[\x21-\x7E]{1,128}$/.test(value) ? value : undefined;
}

function createAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle,
  cancelTimeout: (handle: TimerHandle) => void,
): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) {
    onCallerAbort();
  }
  const timer = scheduleTimeout(() => {
    if (callerSignal?.aborted) {
      return;
    }
    timedOut = true;
    controller.abort(new DOMException("模型请求超时", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup() {
      cancelTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: FetchTransport;
  readonly #retry: RetryPolicy;
  readonly #requestTimeoutMs: number;
  readonly #now: () => number;
  readonly #requestIdFactory: () => string;
  readonly #scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #cancelTimeout: (handle: TimerHandle) => void;
  readonly #logger: SafeLogger;
  readonly #redactor: Redactor;

  constructor(config: Pick<EasyCodeConfig, "apiKey" | "baseUrl">, options: OpenAICompatibleProviderOptions = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
      throw new RangeError("requestTimeoutMs 必须是 1–120000 的整数");
    }
    this.#apiKey = config.apiKey;
    this.#endpoint = endpointFor(new URL(config.baseUrl.toString()));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retry = new RetryPolicy(options.retry ?? DEFAULT_RETRY, {
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.#requestIdFactory = options.requestIdFactory ?? (() => `ec-${randomUUID()}`);
    this.#scheduleTimeout = options.scheduleTimeout ?? setTimeout;
    this.#cancelTimeout = options.cancelTimeout ?? clearTimeout;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#redactor = options.redactor ?? new Redactor({ secrets: [config.apiKey] });
  }

  async *stream(request: ProviderRequest, options: ProviderStreamOptions = {}): AsyncIterable<ProviderEvent> {
    throwIfCallerAborted(options.signal);

    let body: string;
    try {
      body = createChatCompletionsBody(request);
    } catch {
      yield { type: "error", error: ERRORS.protocol };
      return;
    }

    const clientRequestId = safeRequestId(this.#requestIdFactory);
    const path = new URL(this.#endpoint).pathname;
    let attemptNumber = 0;

    while (true) {
      throwIfCallerAborted(options.signal);
      attemptNumber += 1;
      const startedAt = this.#now();
      const attempt = createAttemptSignal(
        options.signal,
        this.#requestTimeoutMs,
        this.#scheduleTimeout,
        this.#cancelTimeout,
      );
      let response: Response | undefined;
      let error: ProviderError | undefined;
      let status: number | undefined;
      let serverRequestId: string | undefined;

      try {
        try {
          response = await this.#fetch(this.#endpoint, {
            method: "POST",
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${this.#apiKey}`,
              "Content-Type": "application/json",
              "X-Client-Request-Id": clientRequestId,
            },
            body,
            signal: attempt.signal,
          });
        } catch {
          throwIfCallerAborted(options.signal);
          error = attempt.didTimeout() ? ERRORS.timeout : ERRORS.network;
        }

        if (response !== undefined) {
          throwIfCallerAborted(options.signal);
          if (attempt.didTimeout()) {
            error = ERRORS.timeout;
            await cancelBody(response);
            throwIfCallerAborted(options.signal);
          } else {
            status = response.status;
            serverRequestId = safeServerRequestId(response.headers);
            if (!response.ok) {
              error = classifyHttpStatus(response.status);
              await cancelBody(response);
              throwIfCallerAborted(options.signal);
            } else if (
              !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ||
              response.body === null
            ) {
              await cancelBody(response);
              throwIfCallerAborted(options.signal);
              error = ERRORS.protocol;
            } else {
              safeLog(this.#logger, this.#redactor, {
                event: "provider_attempt",
                method: "POST",
                path,
                attempt: attemptNumber,
                durationMs: Math.max(0, Math.round(this.#now() - startedAt)),
                clientRequestId,
                status,
                ...(serverRequestId === undefined ? {} : { serverRequestId }),
              });
              yield { type: "start" };
              yield* this.#consumeStream(response.body, attempt, options.signal);
              return;
            }
          }
        }
      } finally {
        attempt.cleanup();
      }

      error ??= ERRORS.network;
      safeLog(this.#logger, this.#redactor, {
        event: "provider_attempt",
        method: "POST",
        path,
        attempt: attemptNumber,
        durationMs: Math.max(0, Math.round(this.#now() - startedAt)),
        clientRequestId,
        ...(status === undefined ? {} : { status }),
        code: error.code,
        ...(serverRequestId === undefined ? {} : { serverRequestId }),
      });

      const retriesUsed = attemptNumber - 1;
      if (!error.retryable || retriesUsed >= this.#retry.maxRetries) {
        yield { type: "error", error };
        return;
      }

      throwIfCallerAborted(options.signal);
      const retryNumber = retriesUsed + 1;
      const retryAfterMs =
        response === undefined ? undefined : parseRetryAfter(response.headers.get("retry-after"), this.#now());
      const delayMs = this.#retry.delayFor(retryNumber, retryAfterMs);
      yield { type: "retry", attempt: retryNumber, maxRetries: this.#retry.maxRetries, delayMs, error };
      throwIfCallerAborted(options.signal);
      await this.#retry.wait(delayMs, options.signal ?? new AbortController().signal);
    }
  }

  async *#consumeStream(
    stream: ReadableStream<Uint8Array>,
    attempt: AttemptSignal,
    callerSignal: AbortSignal | undefined,
  ): AsyncIterable<ProviderEvent> {
    let sawFinish = false;
    let sawUsage = false;
    try {
      for await (const payload of parseSseData(stream, attempt.signal)) {
        throwIfCallerAborted(callerSignal);
        if (payload.trim() === "[DONE]") {
          if (!sawFinish) {
            throw new OpenAICompatibleProtocolError();
          }
          return;
        }

        const chunk = parseChatCompletionChunk(payload);
        if (chunk.usageOnly) {
          if (!sawFinish || sawUsage || chunk.events.length !== 1 || chunk.events[0]?.type !== "usage") {
            throw new OpenAICompatibleProtocolError();
          }
          sawUsage = true;
          yield chunk.events[0];
          continue;
        }
        if (sawFinish) {
          throw new OpenAICompatibleProtocolError();
        }

        for (const event of chunk.events) {
          if (event.type === "finish") {
            if (sawFinish) {
              throw new OpenAICompatibleProtocolError();
            }
            sawFinish = true;
          }
          yield event;
        }
      }
      if (!sawFinish) {
        throw new OpenAICompatibleProtocolError();
      }
    } catch (error) {
      throwIfCallerAborted(callerSignal);
      yield {
        type: "error",
        error: attempt.didTimeout()
          ? ERRORS.timeout
          : error instanceof OpenAICompatibleProtocolError
            ? ERRORS.protocol
            : ERRORS.network,
      };
    }
  }
}
