import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import {
  basicRequest,
  collectProviderEvents,
  completionChunk,
  encode,
  recordFetch,
  responseFromChunks,
  sseData,
} from "../fixtures/openai-compatible.js";

function eventsFor(stream: string) {
  const recorder = recordFetch(responseFromChunks([encode(stream)]));
  const provider = new OpenAICompatibleProvider(
    { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
    { fetch: recorder.fetch, retry: { maxRetries: 0, baseDelayMs: 1 } },
  );
  return collectProviderEvents(provider.stream(basicRequest));
}

describe("M6 usage-only 协议", () => {
  it("归一化完整 usage 并保持在 finish 之后", async () => {
    await expect(
      eventsFor(
        `${sseData(completionChunk({}, "stop"))}${sseData({
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        })}${sseData("[DONE]")}`,
      ),
    ).resolves.toEqual([
      { type: "start" },
      { type: "finish", reason: "stop" },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 } },
    ]);
  });

  it("未提供字段保持 undefined，不补 0", async () => {
    const events = await eventsFor(
      `${sseData(completionChunk({}, "stop"))}${sseData({ choices: [], usage: { total_tokens: 9 } })}`,
    );
    expect(events.at(-1)).toEqual({ type: "usage", usage: { totalTokens: 9 } });
    expect(events.at(-1)).not.toHaveProperty("usage.inputTokens");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("拒绝非法 token 计数 %s", async (totalTokens) => {
    const events = await eventsFor(
      `${sseData(completionChunk({}, "stop"))}${sseData({ choices: [], usage: { total_tokens: totalTokens } })}`,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "provider_protocol" } });
  });

  it("拒绝第二个 usage 事件", async () => {
    const usage = sseData({ choices: [], usage: { total_tokens: 1 } });
    const events = await eventsFor(`${sseData(completionChunk({}, "stop"))}${usage}${usage}`);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "provider_protocol" } });
  });
});
