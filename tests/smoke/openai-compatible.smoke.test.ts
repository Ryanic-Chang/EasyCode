import { describe, expect, it } from "vitest";

import { loadEasyCodeConfig } from "../../src/config/config.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import type { ProviderEvent } from "../../src/llm/provider.js";

const smokeIt = process.env.EASYCODE_SMOKE === "1" ? it : it.skip;

describe("OpenAI-compatible 真实服务 smoke", () => {
  smokeIt("显式启用后完成最小文本流（可能产生 API 费用）", async () => {
    const config = loadEasyCodeConfig(process.env);
    const provider = new OpenAICompatibleProvider(config);
    const events: ProviderEvent[] = [];

    for await (const event of provider.stream({
      model: config.model,
      messages: [{ role: "user", content: "只回复：EasyCode smoke ok" }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text_delta" && event.delta.length > 0)).toBe(true);
    const finishIndex = events.findIndex((event) => event.type === "finish");
    expect(events[finishIndex]).toEqual({ type: "finish", reason: "stop" });
    expect(events.slice(finishIndex + 1).every((event) => event.type === "usage")).toBe(true);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    const usage = events.find((event) => event.type === "usage");
    process.stdout.write(
      `EasyCode smoke：finish=stop tokens=${usage?.type === "usage" ? (usage.usage.totalTokens ?? "unknown") : "unknown"}\n`,
    );
  });
});
