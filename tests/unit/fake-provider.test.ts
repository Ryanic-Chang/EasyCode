import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderRequest } from "../../src/llm/provider.js";
import { FakeProvider } from "../fake-provider.js";

const request: ProviderRequest = {
  model: "fake-model",
  messages: [{ role: "user", content: "检查项目" }],
  tools: [],
};

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("FakeProvider", () => {
  it("按既定脚本输出流式事件并记录请求", async () => {
    const script: ProviderEvent[] = [
      { type: "start" },
      { type: "text_delta", delta: "完成" },
      { type: "finish", reason: "stop" },
    ];
    const provider = new FakeProvider([script]);

    await expect(collect(provider.stream(request))).resolves.toEqual(script);
    expect(provider.requests).toEqual([request]);
  });

  it("按调用顺序消耗多组脚本", async () => {
    const provider = new FakeProvider([
      [{ type: "finish", reason: "tool_calls" }],
      [{ type: "finish", reason: "stop" }],
    ]);

    await expect(collect(provider.stream(request))).resolves.toEqual([{ type: "finish", reason: "tool_calls" }]);
    await expect(collect(provider.stream(request))).resolves.toEqual([{ type: "finish", reason: "stop" }]);
  });

  it("在请求开始前响应取消信号", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider([[{ type: "finish", reason: "stop" }]]);

    await expect(collect(provider.stream(request, { signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(provider.requests).toHaveLength(0);
  });
});
