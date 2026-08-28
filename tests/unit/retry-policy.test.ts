import { describe, expect, it, vi } from "vitest";

import { abortableSleep, MAX_RETRY_AFTER_MS, parseRetryAfter, RetryPolicy } from "../../src/llm/retry.js";

describe("M5 RetryPolicy", () => {
  it("指数退避具有 ±20% jitter 和最大 delay", () => {
    expect(new RetryPolicy({ maxRetries: 2, baseDelayMs: 100 }, { random: () => 0 }).delayFor(1)).toBe(80);
    expect(new RetryPolicy({ maxRetries: 2, baseDelayMs: 100 }, { random: () => 1 }).delayFor(1)).toBe(120);
    const capped = new RetryPolicy({ maxRetries: 5, baseDelayMs: 4_000, maxDelayMs: 10_000 }, { random: () => 1 });
    expect(capped.delayFor(4)).toBe(10_000);
  });

  it("合法 Retry-After 参与计算，非法、负数和过大值安全收敛", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter(new Date(now + 3_000).toUTCString(), now)).toBe(3_000);
    expect(parseRetryAfter("-1", now)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfter("999999", now)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("backoff 可被 AbortSignal 立即打断且不遗留 timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = abortableSleep(10_000, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
