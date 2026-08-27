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
    });
    expect(environment).toEqual(snapshot);
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
