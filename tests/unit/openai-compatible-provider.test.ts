import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import type { ProviderError, ProviderErrorCode, ProviderEvent, ProviderRequest } from "../../src/llm/provider.js";
import {
  basicRequest,
  collectProviderEvents,
  completionChunk,
  encode,
  recordFetch,
  responseFromChunks,
  sseData,
  successfulTextResponse,
} from "../fixtures/openai-compatible.js";

function providerFor(
  fetch: ReturnType<typeof recordFetch>["fetch"],
  baseUrl = "https://example.test/compatible-mode/v1/",
) {
  return new OpenAICompatibleProvider(
    { apiKey: "fixture-key", baseUrl: new URL(baseUrl) },
    { fetch, retry: { maxRetries: 0, baseDelayMs: 1 }, requestIdFactory: () => "fixture-request-id" },
  );
}

function errorEvent(code: ProviderErrorCode, retryable: boolean): ProviderEvent {
  return {
    type: "error",
    error: expect.objectContaining<Partial<ProviderError>>({ code, retryable }) as unknown as ProviderError,
  };
}

describe("OpenAI-compatible 请求适配", () => {
  it("保留 base path 并映射完整消息、ToolCall、ToolResult 与工具定义", async () => {
    const recorder = recordFetch(successfulTextResponse());
    const provider = providerFor(recorder.fetch);
    const request: ProviderRequest = {
      model: "fixture-model",
      messages: [
        { role: "system", content: "遵守约束" },
        { role: "user", content: "读取项目" },
        {
          role: "assistant",
          content: "我先查询",
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { path: "src/main.ts" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "lookup",
          content: "未找到",
          isError: true,
          metadata: { kind: "not_found" },
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "查询文件",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    };

    await expect(collectProviderEvents(provider.stream(request))).resolves.toEqual([
      { type: "start" },
      { type: "text_delta", delta: "完成" },
      { type: "finish", reason: "stop" },
    ]);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(String(call?.input)).toBe("https://example.test/compatible-mode/v1/chat/completions");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toEqual({
      Accept: "text/event-stream",
      Authorization: "Bearer fixture-key",
      "Content-Type": "application/json",
      "X-Client-Request-Id": "fixture-request-id",
    });
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      model: "fixture-model",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "遵守约束" },
        { role: "user", content: "读取项目" },
        {
          role: "assistant",
          content: "我先查询",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"path":"src/main.ts"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content:
            '{"easycode_tool_result":{"tool_name":"lookup","is_error":true,"output":"未找到","metadata":{"kind":"not_found"}}}',
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "查询文件",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
    });
  });

  it.each([
    ["https://example.test/v1", "https://example.test/v1/chat/completions"],
    ["https://example.test/v1/", "https://example.test/v1/chat/completions"],
    ["http://localhost:8080", "http://localhost:8080/chat/completions"],
  ])("稳定拼接 endpoint：%s", async (baseUrl, expected) => {
    const recorder = recordFetch(successfulTextResponse());
    await collectProviderEvents(providerFor(recorder.fetch, baseUrl).stream(basicRequest));
    expect(String(recorder.calls[0]?.input)).toBe(expected);
  });

  it("无法序列化请求时不发起网络请求并返回协议错误", async () => {
    const recorder = recordFetch(successfulTextResponse());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const request: ProviderRequest = {
      ...basicRequest,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "lookup", arguments: cyclic }],
        },
      ],
    };

    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(request))).resolves.toEqual([
      errorEvent("provider_protocol", false),
    ]);
    expect(recorder.calls).toHaveLength(0);
  });
});

describe("OpenAI-compatible SSE 归一化", () => {
  it("处理 CRLF、注释、多事件单 chunk、跨 chunk 事件及拆分的中文 UTF-8", async () => {
    const textEvent = sseData(completionChunk({ role: "assistant", content: "中文" }), "\r\n");
    const bytes = encode(`: keep-alive\r\n\r\n${textEvent}`);
    const chineseOffset = bytes.findIndex((value) => value > 127);
    const chunks = [
      bytes.slice(0, chineseOffset + 1),
      bytes.slice(chineseOffset + 1),
      encode(`${sseData(completionChunk({}, "stop"), "\r\n")}${sseData("[DONE]", "\r\n")}`),
    ];
    const recorder = recordFetch(responseFromChunks(chunks));

    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      { type: "text_delta", delta: "中文" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("保留不同 index 下交错且跨 chunk 的 ToolCall 增量", async () => {
    const payloads = [
      completionChunk({
        tool_calls: [
          { index: 0, id: "call-a", type: "function", function: { name: "read", arguments: '{"pa' } },
          { index: 1, id: "call-b", type: "function", function: { name: "search", arguments: '{"qu' } },
        ],
      }),
      completionChunk({
        tool_calls: [
          { index: 1, function: { arguments: 'ery":"Agent"}' } },
          { index: 0, function: { arguments: 'th":"src"}' } },
        ],
      }),
      completionChunk({}, "tool_calls"),
    ];
    const serialized = payloads.map((payload) => sseData(payload)).join("") + sseData("[DONE]");
    const split = serialized.indexOf("Agent") + 2;
    const recorder = recordFetch(
      responseFromChunks([encode(serialized.slice(0, split)), encode(serialized.slice(split))]),
    );

    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      { type: "tool_call_delta", index: 0, id: "call-a", name: "read", argumentsDelta: '{"pa' },
      { type: "tool_call_delta", index: 1, id: "call-b", name: "search", argumentsDelta: '{"qu' },
      { type: "tool_call_delta", index: 1, argumentsDelta: 'ery":"Agent"}' },
      { type: "tool_call_delta", index: 0, argumentsDelta: 'th":"src"}' },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it.each(["stop", "tool_calls", "length"] as const)("映射 finish_reason=%s", async (reason) => {
    const recorder = recordFetch(
      responseFromChunks([encode(`${sseData(completionChunk({}, reason))}${sseData("[DONE]")}`)]),
    );
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      { type: "finish", reason },
    ]);
  });

  it("接受 finish 后的 usage-only chunk，且 [DONE] 不重复 finish", async () => {
    const recorder = recordFetch(
      responseFromChunks([
        encode(
          `${sseData(completionChunk({}, "stop"))}${sseData({ choices: [], usage: { total_tokens: 7 } })}${sseData(
            "[DONE]",
          )}`,
        ),
      ]),
    );
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("显式 finish 后即使没有 [DONE] 也接受正常 EOF", async () => {
    const recorder = recordFetch(responseFromChunks([encode(sseData(completionChunk({}, "stop")))]));
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      { type: "finish", reason: "stop" },
    ]);
  });
});

describe("OpenAI-compatible 协议拒绝", () => {
  const invalidPayloads: ReadonlyArray<[string, unknown]> = [
    ["非法 JSON", "{not-json"],
    ["缺少 choices", { id: "x" }],
    ["空 choices 缺少 usage", { choices: [] }],
    [
      "多个 choice",
      {
        choices: [
          { index: 0, delta: {}, finish_reason: null },
          { index: 1, delta: {}, finish_reason: null },
        ],
      },
    ],
    ["非零 choice index", completionChunk({}, null, 1)],
    ["缺少 delta", { choices: [{ index: 0, finish_reason: null }] }],
    ["未知 finish reason", completionChunk({}, "future_reason")],
    ["content_filter", completionChunk({}, "content_filter")],
    ["旧式 function_call", completionChunk({ function_call: { name: "legacy", arguments: "{}" } })],
    ["未知 ToolCall type", completionChunk({ tool_calls: [{ index: 0, type: "custom" }] })],
    ["非法 ToolCall index", completionChunk({ tool_calls: [{ index: -1, type: "function" }] })],
  ];

  it.each(invalidPayloads)("拒绝%s", async (_name, payload) => {
    const recorder = recordFetch(responseFromChunks([encode(sseData(payload))]));
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      errorEvent("provider_protocol", false),
    ]);
  });

  it.each([
    ["[DONE] 前没有 finish", sseData("[DONE]")],
    ["异常 EOF", sseData(completionChunk({ content: "未完成" }))],
    [
      "finish 后仍有普通 chunk",
      `${sseData(completionChunk({}, "stop"))}${sseData(completionChunk({ content: "多余" }))}`,
    ],
    ["usage-only 出现在 finish 前", sseData({ choices: [], usage: { total_tokens: 1 } })],
  ])("拒绝%s", async (_name, stream) => {
    const recorder = recordFetch(responseFromChunks([encode(stream)]));
    const events = await collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest));
    expect(events.at(-1)).toEqual(errorEvent("provider_protocol", false));
  });

  it("拒绝损坏的 UTF-8", async () => {
    const recorder = recordFetch(responseFromChunks([new Uint8Array([0xff, 0xfe])]));
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      { type: "start" },
      errorEvent("provider_protocol", false),
    ]);
  });

  it.each([
    ["错误 content-type", new Response("ok", { headers: { "content-type": "application/json" } })],
    ["空响应体", new Response(null, { headers: { "content-type": "text/event-stream" } })],
  ])("拒绝%s", async (_name, response) => {
    const recorder = recordFetch(response);
    await expect(collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest))).resolves.toEqual([
      errorEvent("provider_protocol", false),
    ]);
  });
});

describe("OpenAI-compatible 错误与取消", () => {
  it.each([
    [401, "provider_authentication", false],
    [403, "provider_authentication", false],
    [429, "provider_rate_limit", true],
    [400, "provider_http", false],
    [408, "provider_timeout", true],
    [409, "provider_http", true],
    [425, "provider_http", false],
    [500, "provider_server", true],
    [503, "provider_server", true],
  ] as const)("HTTP %i 映射为 %s", async (status, code, retryable) => {
    const recorder = recordFetch(new Response("SENSITIVE_FIXTURE_VALUE", { status }));
    const events = await collectProviderEvents(providerFor(recorder.fetch).stream(basicRequest));
    expect(events).toEqual([errorEvent(code, retryable)]);
    expect(JSON.stringify(events)).not.toContain("SENSITIVE_FIXTURE_VALUE");
    expect(JSON.stringify(events)).not.toContain("fixture-key");
  });

  it("fetch 抛出异常时返回脱敏网络错误", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("SENSITIVE_NETWORK_DETAIL");
    });
    const events = await collectProviderEvents(providerFor(fetch).stream(basicRequest));
    expect(events).toEqual([errorEvent("provider_network", true)]);
    expect(JSON.stringify(events)).not.toContain("SENSITIVE_NETWORK_DETAIL");
  });

  it("HTTP 错误正文清理期间发生取消时优先保留 AbortError", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        controller.abort();
      },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 500 }));

    await expect(
      collectProviderEvents(providerFor(fetch).stream(basicRequest, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("将调用方取消组合进 attempt signal，并在流中取消时释放 reader、不转成 Provider 错误", async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        streamController = value;
      },
      cancel,
    });
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const collecting = collectProviderEvents(providerFor(fetch).stream(basicRequest, { signal: controller.signal }));

    await vi.waitFor(() => expect(streamController).toBeDefined());
    streamController?.enqueue(encode(sseData(completionChunk({ content: "开始" }))));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();

    await expect(collecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("请求开始前已取消时不调用 fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => successfulTextResponse());

    await expect(
      collectProviderEvents(providerFor(fetch).stream(basicRequest, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
