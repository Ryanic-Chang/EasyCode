import { describe, expect, it, vi } from "vitest";

import { type FetchTransport, OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import type { ProviderEvent } from "../../src/llm/provider.js";
import type { ProviderLogEntry } from "../../src/security/logger.js";
import {
  basicRequest,
  collectProviderEvents,
  completionChunk,
  encode,
  responseFromChunks,
  sseData,
  successfulTextResponse,
} from "../fixtures/openai-compatible.js";

function retryingProvider(
  fetch: FetchTransport,
  overrides: ConstructorParameters<typeof OpenAICompatibleProvider>[1] = {},
) {
  return new OpenAICompatibleProvider(
    { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
    {
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 100 },
      random: () => 0.5,
      sleep: async () => undefined,
      requestIdFactory: () => "logical-request-1",
      ...overrides,
    },
  );
}

function retryEvent(code: string, attempt = 1): Partial<ProviderEvent> {
  return {
    type: "retry",
    attempt,
    maxRetries: 2,
    delayMs: 100,
    error: expect.objectContaining({ code }),
  } as Partial<ProviderEvent>;
}

describe("M5 Provider 有界重试", () => {
  it.each([429, 500, 503])("HTTP %s 释放失败 body 后重试并成功", async (status) => {
    const cancel = vi.fn();
    const failedBody = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi
      .fn<FetchTransport>()
      .mockResolvedValueOnce(new Response(failedBody, { status, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(successfulTextResponse());
    const events = await collectProviderEvents(
      retryingProvider(fetch, {
        sleep: async (delay) => {
          expect(delay).toBe(1_000);
        },
      }).stream(basicRequest),
    );
    expect(events[0]).toMatchObject({
      ...retryEvent(status === 429 ? "provider_rate_limit" : "provider_server"),
      delayMs: 1_000,
    });
    expect(events.slice(1)).toEqual([
      { type: "start" },
      { type: "text_delta", delta: "完成" },
      { type: "finish", reason: "stop" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("network failure 重试成功，所有 attempts 共用 logical request ID；下一逻辑请求使用新 ID", async () => {
    const ids = ["logical-1", "logical-2"];
    const fetch = vi
      .fn<FetchTransport>()
      .mockRejectedValueOnce(new Error("synthetic network secret"))
      .mockResolvedValueOnce(successfulTextResponse())
      .mockResolvedValueOnce(successfulTextResponse());
    const provider = retryingProvider(fetch, { requestIdFactory: () => ids.shift() ?? "unexpected" });
    const first = await collectProviderEvents(provider.stream(basicRequest));
    const second = await collectProviderEvents(provider.stream(basicRequest));
    expect(first[0]).toMatchObject(retryEvent("provider_network"));
    expect(second[0]).toEqual({ type: "start" });
    const headers = fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Client-Request-Id"));
    expect(headers).toEqual(["logical-1", "logical-1", "logical-2"]);
    expect(JSON.stringify(first)).not.toContain("synthetic network secret");
  });

  it("timeout 在流开始前可重试，调用方 abort 优先且不进入下一 attempt", async () => {
    let schedules = 0;
    const fetch = vi.fn<FetchTransport>(async (_input, init) => {
      if (fetch.mock.calls.length === 1) {
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return successfulTextResponse();
    });
    const provider = retryingProvider(fetch, {
      scheduleTimeout: (callback) => {
        schedules += 1;
        if (schedules === 1) queueMicrotask(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelTimeout: () => undefined,
    });
    const events = await collectProviderEvents(provider.stream(basicRequest));
    expect(events[0]).toMatchObject(retryEvent("provider_timeout"));
    expect(fetch).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
      controller.abort();
      signal.throwIfAborted();
    });
    const abortedFetch = vi.fn<FetchTransport>().mockRejectedValueOnce(new Error("offline"));
    await expect(
      collectProviderEvents(
        retryingProvider(abortedFetch, { sleep }).stream(basicRequest, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedFetch).toHaveBeenCalledOnce();
  });

  it("transport 忽略内部 abort 并迟到返回时仍按 timeout 处理且释放 response", async () => {
    let schedules = 0;
    const cancel = vi.fn();
    const lateBody = new ReadableStream<Uint8Array>({ cancel });
    let fetchCalls = 0;
    const fetch: FetchTransport = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(lateBody, { headers: { "content-type": "text/event-stream" } });
      }
      return successfulTextResponse();
    };
    const provider = retryingProvider(fetch, {
      scheduleTimeout: (callback) => {
        schedules += 1;
        if (schedules === 1) callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelTimeout: () => undefined,
    });

    const events = await collectProviderEvents(provider.stream(basicRequest));
    expect(events[0]).toMatchObject(retryEvent("provider_timeout"));
    expect(events[1]).toEqual({ type: "start" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchCalls).toBe(2);
  });

  it("调用方 abort 与内部 timeout 同时发生时 abort 优先且不重试", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchTransport>(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return successfulTextResponse();
    });
    const provider = retryingProvider(fetch, {
      scheduleTimeout: (callback) => {
        controller.abort();
        callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelTimeout: () => undefined,
    });

    await expect(
      collectProviderEvents(provider.stream(basicRequest, { signal: controller.signal })),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("重试耗尽只发布一次最终 error，401/403/400/404/422/protocol 均不重试", async () => {
    const exhausted = vi.fn<FetchTransport>().mockRejectedValue(new Error("offline"));
    const events = await collectProviderEvents(retryingProvider(exhausted).stream(basicRequest));
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "provider_network" }) }),
    ]);
    expect(exhausted).toHaveBeenCalledTimes(3);

    for (const status of [400, 401, 403, 404, 422]) {
      const fetch = vi.fn<FetchTransport>().mockResolvedValue(new Response("fixture", { status }));
      const one = await collectProviderEvents(retryingProvider(fetch).stream(basicRequest));
      expect(fetch).toHaveBeenCalledOnce();
      expect(one).toHaveLength(1);
      expect(one[0]?.type).toBe("error");
    }
    const protocolFetch = vi
      .fn<FetchTransport>()
      .mockResolvedValue(new Response("json", { status: 200, headers: { "content-type": "application/json" } }));
    const protocol = await collectProviderEvents(retryingProvider(protocolFetch).stream(basicRequest));
    expect(protocolFetch).toHaveBeenCalledOnce();
    expect(protocol).toEqual([
      expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "provider_protocol" }) }),
    ]);
  });

  it("SSE start/text 后断流不透明重放，logger 抛错不改变结果", async () => {
    const broken = responseFromChunks([encode(sseData(completionChunk({ content: "已输出" })))]);
    const fetch = vi.fn<FetchTransport>().mockResolvedValue(broken);
    const logger = {
      log: vi.fn((_entry: ProviderLogEntry) => {
        throw new Error("logger secret");
      }),
    };
    const events = await collectProviderEvents(retryingProvider(fetch, { logger }).stream(basicRequest));
    expect(events).toEqual([
      { type: "start" },
      { type: "text_delta", delta: "已输出" },
      expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "provider_protocol" }) }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
  });
});
