export const CONFIG_ENV_NAMES = ["EASYCODE_API_KEY", "EASYCODE_BASE_URL", "EASYCODE_MODEL"] as const;

export type EasyCodeEnvironment = Readonly<Record<string, string | undefined>>;

export interface EasyCodeConfig {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly model: string;
}

export class ConfigError extends Error {
  readonly code: "missing_value" | "invalid_url" | "unsupported_scheme";

  constructor(code: ConfigError["code"], message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function requireValue(environment: EasyCodeEnvironment, name: (typeof CONFIG_ENV_NAMES)[number]): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigError("missing_value", `缺少必需配置：${name}`);
  }
  return value;
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("invalid_url", "EASYCODE_BASE_URL 必须是有效的绝对 URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("unsupported_scheme", "EASYCODE_BASE_URL 只支持 http 或 https");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new ConfigError("invalid_url", "EASYCODE_BASE_URL 不能包含用户信息、查询参数或片段");
  }
  return url;
}

export function loadEasyCodeConfig(environment: EasyCodeEnvironment): EasyCodeConfig {
  const apiKey = requireValue(environment, "EASYCODE_API_KEY");
  const baseUrl = parseBaseUrl(requireValue(environment, "EASYCODE_BASE_URL"));
  const model = requireValue(environment, "EASYCODE_MODEL");

  return { apiKey, baseUrl, model };
}
