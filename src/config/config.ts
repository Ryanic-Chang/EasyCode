export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const CONFIG_ENV_NAMES = [
  "EASYCODE_API_KEY",
  "EASYCODE_BASE_URL",
  "EASYCODE_MODEL",
  "EASYCODE_MAX_RETRIES",
  "EASYCODE_RETRY_BASE_DELAY_MS",
  "EASYCODE_REQUEST_TIMEOUT_MS",
  "EASYCODE_ENABLE_THINKING",
] as const;

export type EasyCodeEnvironment = Readonly<Record<string, string | undefined>>;

export interface EasyCodeConfig {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly model: string;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly requestTimeoutMs: number;
  readonly enableThinking?: boolean;
}

export class ConfigError extends Error {
  readonly code: "missing_value" | "invalid_url" | "unsupported_scheme" | "invalid_integer" | "invalid_boolean";

  constructor(code: ConfigError["code"], message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function optionalBoolean(
  environment: EasyCodeEnvironment,
  name: (typeof CONFIG_ENV_NAMES)[number],
): boolean | undefined {
  const raw = environment[name];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new ConfigError("invalid_boolean", `${name} 只接受 true 或 false`);
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

function optionalInteger(
  environment: EasyCodeEnvironment,
  name: (typeof CONFIG_ENV_NAMES)[number],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new ConfigError("invalid_integer", `${name} 必须是 ${minimum}–${maximum} 的十进制整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError("invalid_integer", `${name} 必须是 ${minimum}–${maximum} 的十进制整数`);
  }
  return value;
}

export function loadEasyCodeConfig(environment: EasyCodeEnvironment): EasyCodeConfig {
  const apiKey = requireValue(environment, "EASYCODE_API_KEY");
  const baseUrl = parseBaseUrl(requireValue(environment, "EASYCODE_BASE_URL"));
  const model = requireValue(environment, "EASYCODE_MODEL");
  const maxRetries = optionalInteger(environment, "EASYCODE_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 5);
  const retryBaseDelayMs = optionalInteger(
    environment,
    "EASYCODE_RETRY_BASE_DELAY_MS",
    DEFAULT_RETRY_BASE_DELAY_MS,
    50,
    5_000,
  );
  const requestTimeoutMs = optionalInteger(
    environment,
    "EASYCODE_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    1_000,
    120_000,
  );
  const enableThinking = optionalBoolean(environment, "EASYCODE_ENABLE_THINKING");

  return {
    apiKey,
    baseUrl,
    model,
    maxRetries,
    retryBaseDelayMs,
    requestTimeoutMs,
    ...(enableThinking === undefined ? {} : { enableThinking }),
  };
}
