import { describe, expect, it } from "vitest";

import { type ConfigError, loadEasyCodeConfig } from "../../src/config/config.js";

const validEnvironment = {
  EASYCODE_API_KEY: "fixture-key",
  EASYCODE_BASE_URL: "https://example.test/compatible-mode/v1/",
  EASYCODE_MODEL: "fixture-model",
};

describe("Provider 配置", () => {
  it("显式读取并规范化三个必需变量，不修改输入", () => {
    const environment = { ...validEnvironment, EASYCODE_MODEL: "  fixture-model  " };
    const snapshot = { ...environment };

    expect(loadEasyCodeConfig(environment)).toEqual({
      apiKey: "fixture-key",
      baseUrl: new URL("https://example.test/compatible-mode/v1/"),
      model: "fixture-model",
      maxRetries: 2,
      retryBaseDelayMs: 500,
      requestTimeoutMs: 30_000,
    });
    expect(environment).toEqual(snapshot);
  });

  it("读取严格有界的 retry 与 timeout 配置", () => {
    expect(
      loadEasyCodeConfig({
        ...validEnvironment,
        EASYCODE_MAX_RETRIES: "5",
        EASYCODE_RETRY_BASE_DELAY_MS: "50",
        EASYCODE_REQUEST_TIMEOUT_MS: "120000",
      }),
    ).toMatchObject({ maxRetries: 5, retryBaseDelayMs: 50, requestTimeoutMs: 120_000 });
  });

  it.each([
    ["EASYCODE_MAX_RETRIES", ""],
    ["EASYCODE_MAX_RETRIES", "-1"],
    ["EASYCODE_MAX_RETRIES", "6"],
    ["EASYCODE_MAX_RETRIES", "1.5"],
    ["EASYCODE_MAX_RETRIES", " 1"],
    ["EASYCODE_RETRY_BASE_DELAY_MS", "49"],
    ["EASYCODE_RETRY_BASE_DELAY_MS", "Infinity"],
    ["EASYCODE_REQUEST_TIMEOUT_MS", "999"],
    ["EASYCODE_REQUEST_TIMEOUT_MS", "NaN"],
    ["EASYCODE_REQUEST_TIMEOUT_MS", "120001"],
  ])("拒绝非法整数配置 %s=%s", (name, value) => {
    expect(() => loadEasyCodeConfig({ ...validEnvironment, [name]: value })).toThrowError(
      expect.objectContaining<Partial<ConfigError>>({ code: "invalid_integer" }),
    );
  });

  it.each(["EASYCODE_API_KEY", "EASYCODE_BASE_URL", "EASYCODE_MODEL"] as const)(
    "缺少或留空 %s 时给出稳定错误",
    (name) => {
      for (const value of [undefined, "   "]) {
        const environment = { ...validEnvironment, [name]: value };
        expect(() => loadEasyCodeConfig(environment)).toThrowError(
          expect.objectContaining<Partial<ConfigError>>({ code: "missing_value" }),
        );
      }
    },
  );

  it.each([
    ["not-a-url", "invalid_url"],
    ["ftp://example.test/v1", "unsupported_scheme"],
    ["https://user:secret@example.test/v1", "invalid_url"],
    ["https://example.test/v1?debug=true", "invalid_url"],
    ["https://example.test/v1#fragment", "invalid_url"],
  ] as const)("拒绝无效 base URL：%s", (baseUrl, code) => {
    expect(() => loadEasyCodeConfig({ ...validEnvironment, EASYCODE_BASE_URL: baseUrl })).toThrowError(
      expect.objectContaining<Partial<ConfigError>>({ code }),
    );
  });

  it("配置错误不包含 API key", () => {
    const secret = "SENSITIVE_FIXTURE_KEY";
    try {
      loadEasyCodeConfig({ ...validEnvironment, EASYCODE_API_KEY: secret, EASYCODE_BASE_URL: "bad" });
      throw new Error("预期配置加载失败");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
