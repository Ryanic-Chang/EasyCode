import { ToolInputError } from "./errors.js";

export type InputRecord = Readonly<Record<string, unknown>>;

function isInputRecord(input: unknown): input is InputRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function requireRecord(input: unknown): InputRecord {
  if (!isInputRecord(input)) {
    throw new ToolInputError("工具参数必须是 JSON object");
  }
  return input;
}

export function rejectUnknownKeys(input: InputRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new ToolInputError(`不支持的工具参数：${unknown}`);
  }
}

export function requireString(input: InputRecord, key: string, maxLength: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new ToolInputError(`${key} 必须是长度为 1–${maxLength} 且不含 NUL 的字符串`);
  }
  return value;
}

export function optionalString(input: InputRecord, key: string, maxLength: number): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new ToolInputError(`${key} 必须是长度为 1–${maxLength} 且不含 NUL 的字符串`);
  }
  return value;
}

export function optionalBoolean(input: InputRecord, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${key} 必须是 boolean`);
  }
  return value;
}

export function optionalInteger(
  input: InputRecord,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[key];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new ToolInputError(`${key} 必须是 ${minimum}–${maximum} 的整数`);
  }
  return value;
}

export function optionalPositiveInteger(input: InputRecord, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new ToolInputError(`${key} 必须是正整数`);
  }
  return value;
}
