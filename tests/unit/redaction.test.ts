import { describe, expect, it } from "vitest";

import { type ProviderLogEntry, safeLog } from "../../src/security/logger.js";
import { REDACTED_VALUE, Redactor, TRUNCATION_MARKER } from "../../src/security/redaction.js";
import { MAX_AGENT_TOOL_OUTPUT_BYTES, sanitizeToolExecutionResult } from "../../src/security/tool-result.js";

describe("M5 敏感信息过滤", () => {
  it("过滤显式 secret、凭据格式、URL userinfo/query 及大小写和多行变体", () => {
    const secret = "fixture-secret-value";
    const redactor = new Redactor({ secrets: [secret] });
    const input = [
      secret,
      "Authorization: Bearer abcdefghijklmnop",
      "SK-fixture123456789",
      "API_KEY=fixture-key-value",
      "Password: fixture-password",
      "https://name:pass@example.test/path?access_token=fixture-token&signature=fixture-signature",
    ].join("\n");

    const output = redactor.redactText(input);
    expect(output).not.toContain(secret);
    expect(output).not.toMatch(
      /abcdefghijklmnop|fixture-key-value|fixture-password|fixture-token|fixture-signature|name:pass/i,
    );
    expect(
      output.match(new RegExp(REDACTED_VALUE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length,
    ).toBeGreaterThan(4);
  });

  it("保留普通源码中的 token 标识符且不修改原对象", () => {
    const redactor = new Redactor();
    const source = "const tokenCount = tokenizer.count(tokens);";
    const metadata = { source, nested: { ok: true }, apiKey: "synthetic-secret" };
    const before = structuredClone(metadata);

    expect(redactor.redactText(source)).toBe(source);
    const sanitized = redactor.sanitizeMetadata(metadata).value;
    expect(sanitized).toMatchObject({ source, nested: { ok: true }, apiKey: REDACTED_VALUE });
    expect(metadata).toEqual(before);
  });

  it("安全收敛循环、数组、非法值和 getter，且标记不完整数据", () => {
    const redactor = new Redactor({ maxMetadataDepth: 2, maxMetadataFields: 8, maxArrayItems: 2 });
    const metadata: Record<string, unknown> = { values: [1, 2, 3], invalid: Number.NaN };
    metadata.self = metadata;
    Object.defineProperty(metadata, "explosive", {
      enumerable: true,
      get: () => {
        throw new Error("不得读取");
      },
    });

    const sanitized = redactor.sanitizeMetadata(metadata);
    expect(sanitized.truncated).toBe(true);
    expect(sanitized.value).toMatchObject({
      self: "[循环引用已省略]",
      values: [1, 2],
      invalid: "[非法数值已省略]",
      explosive: "[不可读取]",
      easycodeTruncated: true,
    });
  });

  it("按 UTF-8 byte 上限截断 Unicode，不产生替换字符", () => {
    const result = new Redactor().redactTextDetailed("你好🙂".repeat(20_000), 128);
    expect(result.truncated).toBe(true);
    expect(result.value).toContain(TRUNCATION_MARKER);
    expect(result.value).not.toContain("�");
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(128);
  });
});

describe("M5 ToolResult Agent 边界", () => {
  it("在进入历史前过滤 output/stdout/stderr、循环 metadata，并实施全局 byte 上限", () => {
    const secret = "fixture-tool-secret";
    const metadata: Record<string, unknown> = {
      stdout: `Authorization: Bearer ${secret}`,
      stderr: `api_key=${secret}`,
      password: secret,
    };
    metadata.self = metadata;

    const result = sanitizeToolExecutionResult(
      { output: `${secret}\n${"🙂".repeat(20_000)}`, isError: false, metadata },
      new Redactor({ secrets: [secret] }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MAX_AGENT_TOOL_OUTPUT_BYTES);
    expect(result.metadata).toMatchObject({ outputTruncated: true, metadataTruncated: true });
  });

  it("拒绝 getter 或畸形 ToolResult，且不回退到原始值", () => {
    const dangerous = {};
    Object.defineProperty(dangerous, "output", {
      enumerable: true,
      get: () => {
        throw new Error("fixture-leak");
      },
    });
    const result = sanitizeToolExecutionResult(dangerous, new Redactor());
    expect(result).toMatchObject({ isError: true, metadata: { kind: "invalid_result" } });
    expect(JSON.stringify(result)).not.toContain("fixture-leak");
  });
});

describe("M5 最小安全 logger", () => {
  it("只交付窄结构字段并在回调前过滤 path 与 request ID", () => {
    const secret = "fixture-logger-secret";
    let received: ProviderLogEntry | undefined;
    safeLog(
      {
        log: (entry) => {
          received = entry;
        },
      },
      new Redactor({ secrets: [secret] }),
      {
        event: "provider_attempt",
        method: "POST",
        path: `/v1/chat/completions?token=${secret}`,
        attempt: 1,
        durationMs: 10,
        clientRequestId: secret,
        status: 429,
        code: "provider_rate_limit",
        serverRequestId: secret,
      },
    );
    expect(received).toBeDefined();
    expect(JSON.stringify(received)).not.toContain(secret);
    expect(received).toMatchObject({ method: "POST", status: 429, attempt: 1, code: "provider_rate_limit" });
  });
});
