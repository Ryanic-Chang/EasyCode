import type { ToolExecutionResult } from "./tool.js";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolDomainError";
    this.code = code;
  }
}

export function domainFailure(error: ToolDomainError): ToolExecutionResult {
  return {
    output: error.message,
    isError: true,
    metadata: { kind: error.code },
  };
}
