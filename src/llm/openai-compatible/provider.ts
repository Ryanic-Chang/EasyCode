import type { EasyCodeConfig } from "../../config/config.js";
import type { Provider, ProviderError, ProviderEvent, ProviderRequest, ProviderStreamOptions } from "../provider.js";
import { OpenAICompatibleProtocolError } from "./protocol-error.js";
import { parseSseData } from "./sse.js";
import { createChatCompletionsBody, parseChatCompletionChunk } from "./wire.js";

export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
  readonly fetch?: FetchTransport;
}

const ERRORS = {
  authentication: {
    code: "authentication",
    message: "模型服务鉴权失败，请检查 API key。",
    retryable: false,
  },
  rateLimit: {
    code: "rate_limit",
    message: "模型服务请求过于频繁，请稍后重试。",
    retryable: true,
  },
  server: {
    code: "server_error",
    message: "模型服务暂时不可用，请稍后重试。",
    retryable: true,
  },
  http: {
    code: "http_error",
    message: "模型服务拒绝了请求，请检查配置或请求参数。",
    retryable: false,
  },
  network: {
    code: "network_error",
    message: "无法连接模型服务，请检查网络后重试。",
    retryable: true,
  },
  protocol: {
    code: "protocol_error",
    message: "模型服务返回了无法解析的响应。",
    retryable: false,
  },
} as const satisfies Readonly<Record<string, ProviderError>>;

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
  if (status === 429) {
    return ERRORS.rateLimit;
  }
  if (status >= 500 && status <= 599) {
    return ERRORS.server;
  }
  return {
    ...ERRORS.http,
    retryable: status === 408 || status === 409 || status === 425,
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 错误响应正文不参与分类，清理失败也不能泄漏正文或覆盖稳定错误。
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: FetchTransport;

  constructor(config: Pick<EasyCodeConfig, "apiKey" | "baseUrl">, options: OpenAICompatibleProviderOptions = {}) {
    this.#apiKey = config.apiKey;
    this.#endpoint = endpointFor(new URL(config.baseUrl.toString()));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest, options: ProviderStreamOptions = {}): AsyncIterable<ProviderEvent> {
    throwIfAborted(options.signal);

    let body: string;
    try {
      body = createChatCompletionsBody(request);
    } catch {
      yield { type: "error", error: ERRORS.protocol };
      return;
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      throwIfAborted(options.signal);
      yield { type: "error", error: ERRORS.network };
      return;
    }
    throwIfAborted(options.signal);

    if (!response.ok) {
      await cancelBody(response);
      throwIfAborted(options.signal);
      yield { type: "error", error: classifyHttpStatus(response.status) };
      return;
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || response.body === null) {
      await cancelBody(response);
      throwIfAborted(options.signal);
      yield { type: "error", error: ERRORS.protocol };
      return;
    }

    yield { type: "start" };
    let sawFinish = false;

    try {
      for await (const payload of parseSseData(response.body, options.signal)) {
        throwIfAborted(options.signal);
        if (payload.trim() === "[DONE]") {
          if (!sawFinish) {
            throw new OpenAICompatibleProtocolError();
          }
          return;
        }

        const chunk = parseChatCompletionChunk(payload);
        if (chunk.usageOnly) {
          if (!sawFinish) {
            throw new OpenAICompatibleProtocolError();
          }
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
      throwIfAborted(options.signal);
      yield {
        type: "error",
        error: error instanceof OpenAICompatibleProtocolError ? ERRORS.protocol : ERRORS.network,
      };
    }
  }
}
