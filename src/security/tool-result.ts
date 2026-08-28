import type { ToolExecutionResult } from "../tools/tool.js";
import { REDACTED_VALUE, type Redactor } from "./redaction.js";

export const MAX_AGENT_TOOL_OUTPUT_BYTES = 32 * 1024;

function dataProperty(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

export function sanitizeToolExecutionResult(input: unknown, redactor: Redactor): ToolExecutionResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { output: "工具返回了无效结果，已安全拒绝。", isError: true, metadata: { kind: "invalid_result" } };
    }
    const rawOutput = dataProperty(input, "output");
    const rawIsError = dataProperty(input, "isError");
    const rawMetadata = dataProperty(input, "metadata");
    if (typeof rawOutput !== "string" || typeof rawIsError !== "boolean") {
      return { output: "工具返回了无效结果，已安全拒绝。", isError: true, metadata: { kind: "invalid_result" } };
    }

    const output = redactor.redactTextDetailed(rawOutput, MAX_AGENT_TOOL_OUTPUT_BYTES);
    const sanitizedMetadata = rawMetadata === undefined ? undefined : redactor.sanitizeMetadata(rawMetadata);
    const metadata = {
      ...(sanitizedMetadata?.value ?? {}),
      ...(output.truncated ? { outputTruncated: true } : {}),
      ...(sanitizedMetadata?.truncated ? { metadataTruncated: true } : {}),
    };
    return {
      output: output.value,
      isError: rawIsError,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
  } catch {
    return {
      output: `工具结果无法安全处理：${REDACTED_VALUE}`,
      isError: true,
      metadata: { kind: "sanitization_failed" },
    };
  }
}
