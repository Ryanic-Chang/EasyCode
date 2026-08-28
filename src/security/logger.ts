import type { Redactor } from "./redaction.js";

export interface ProviderLogEntry {
  readonly event: "provider_attempt";
  readonly method: "POST";
  readonly path: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly clientRequestId: string;
  readonly status?: number;
  readonly code?: string;
  readonly serverRequestId?: string;
}

export interface SafeLogger {
  log(entry: ProviderLogEntry): void;
}

export const SILENT_LOGGER: SafeLogger = { log: () => undefined };

export function safeLog(logger: SafeLogger, redactor: Redactor, entry: ProviderLogEntry): void {
  try {
    logger.log({
      ...entry,
      path: redactor.redactText(entry.path, 512),
      clientRequestId: redactor.redactText(entry.clientRequestId, 128),
      ...(entry.serverRequestId === undefined
        ? {}
        : { serverRequestId: redactor.redactText(entry.serverRequestId, 128) }),
    });
  } catch {
    // 日志回调不是业务路径，失败不能替换 Provider 结果。
  }
}
